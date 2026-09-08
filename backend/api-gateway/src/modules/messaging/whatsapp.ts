import { createHash, randomBytes } from 'node:crypto'
import { hashSearchable, withTenant, type TenantTransaction } from '@petshop/db'
import {
  findTemplateDefinition,
  whatsappWarmupCap,
  type WhatsappConnection,
  type WhatsappInstanceStatus,
} from '@petshop/shared-types'
import { loadEnv } from '../../config/env.js'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { invalid, invalidTransition, providerUnavailable } from './errors.js'
import { logger } from '../../shared/logger.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheDelete, cacheGet, cacheSet } from '../../shared/redis.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher } from './crypto.js'
import { resolveDelivery } from './recipient.js'
import { EvolutionRequestError, getEvolutionPort } from './ports/evolution.js'
import { loadSettings } from './settings.js'

/**
 * A conexão de WhatsApp do estabelecimento (MOD-CRM-01).
 *
 * Uma instância por tenant, com o número do próprio petshop, pareada por QR code. Três
 * coisas neste arquivo merecem ser lidas antes de mexer:
 *
 * 1. **Desconectar nunca descarta mensagem.** O celular do dono ficou três dias sem
 *    internet e a fila continua íntegra, esperando. Quem transforma "canal fora" em
 *    `SCHEDULED` em vez de `DEAD` é o `dispatch.ts`, e é o AC-04.
 * 2. **Banimento é a única transição que o motor de envio provoca.** Todas as outras
 *    vêm do webhook ou do admin; o `WHATSAPP_BANNED` do adaptador é o que faz o canal
 *    inteiro cair para o e-mail sem ninguém intervir (AC-05).
 * 3. **O token do webhook existe em claro uma vez só**, na criação da instância, e vai
 *    para a Evolution. Aqui fica o hash — quem lê o banco não consegue forjar um
 *    callback.
 */

/** A instância como o resto do serviço a enxerga. Nunca sai para a tela. */
export interface WhatsappCredentials {
  instanceName: string
  apiKey: string
}

interface InstanceRow {
  tenantId: string
  instanceName: string
  status: WhatsappInstanceStatus
  phoneE164: string | null
  apiKeyEncrypted: string | null
  connectedAt: Date | null
  lastSeenAt: Date | null
  warmupStartedAt: Date | null
  lastError: string | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * `tenant-<slug>` — o nome que a Evolution conhece.
 *
 * Derivado do slug e não do id porque é o que aparece nos logs dela e no painel de
 * quem opera o servidor: `tenant-petshopdojoao` diz de quem é a sessão, um UUID não.
 * O slug do tenant é travado (vira subdomínio e vai em QR code impresso), então não há
 * risco de o nome divergir depois.
 */
export function instanceNameFor(slug: string): string {
  return `tenant-${slug}`.slice(0, 80)
}

async function readInstance(tx: TenantTransaction, tenantId: string): Promise<InstanceRow | null> {
  return tx.whatsappInstance.findUnique({ where: { tenantId } })
}

// ─── Disponibilidade ─────────────────────────────────────────────────────────

/**
 * O canal está de pé para **este** tenant?
 *
 * Consultado uma vez por candidato da cascata `AUTO`, por mensagem — daí o cache. O
 * TTL é curto e o webhook o derruba: o preço de errar é assimétrico, e um cache velho
 * dizendo "conectado" custa uma volta na fila, enquanto um dizendo "desconectado"
 * manda por e-mail algo que iria por WhatsApp.
 */
export async function isWhatsappConnected(tenantId: string): Promise<boolean> {
  const cached = await cacheGet<{ connected: boolean }>(CACHE_KEYS.whatsapp(tenantId))
  if (cached) return cached.connected

  if (!getEvolutionPort().configured) return false

  const row = await withTenant(tenantId, (tx) => readInstance(tx, tenantId))
  const connected = row?.status === 'CONNECTED'
  await cacheSet(CACHE_KEYS.whatsapp(tenantId), { connected }, CACHE_TTL_SECONDS.whatsapp)
  return connected
}

/**
 * As credenciais para enviar. Fora do cache de propósito: a chave da instância é
 * credencial, está cifrada com a DEK do tenant no banco, e guardá-la em claro no Redis
 * desfaria isso por uma consulta economizada num caminho que já abre transação.
 */
export async function whatsappCredentials(tenantId: string): Promise<WhatsappCredentials | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await readInstance(tx, tenantId)
    if (!row || row.status !== 'CONNECTED' || !row.apiKeyEncrypted) return null

    const cipher = await openCipher(tx, tenantId)
    try {
      return { instanceName: row.instanceName, apiKey: cipher.decrypt(row.apiKeyEncrypted) }
    } catch (error) {
      // Chave ilegível é instância inutilizável: a rotação da DEK, ou uma linha
      // escrita por outra instalação. Melhor cair para o e-mail que falhar em laço.
      logger.error({ err: error, tenantId }, 'não foi possível decifrar a chave da instância')
      return null
    }
  })
}

/**
 * Quando o número deste tenant foi pareado pela primeira vez, ou `null`.
 *
 * Lido pelo `dispatch.ts` a cada envio de WhatsApp para aplicar a RN-06. Sem cache de
 * propósito: é uma leitura de chave primária dentro de um caminho que já abre
 * transação, e um valor velho aqui significaria enviar acima do teto de aquecimento —
 * exatamente o que a regra existe para impedir.
 */
export async function warmupStartedAt(tenantId: string): Promise<Date | null> {
  const row = await withTenant(tenantId, (tx) =>
    tx.whatsappInstance.findUnique({
      where: { tenantId },
      select: { warmupStartedAt: true },
    }),
  )
  return row?.warmupStartedAt ?? null
}

async function invalidateCache(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.whatsapp(tenantId))
}

/**
 * O QR corrente, como o provedor o entregou pela última vez.
 *
 * Fica no Redis e não no banco porque é estado de segundos: a Evolution roda o código
 * a cada ~45s, e o que interessa é sempre o último. Sem Redis a tela volta a depender
 * do QR devolvido no clique — degrada para o comportamento antigo, não quebra.
 */
async function readCachedQrCode(tenantId: string): Promise<string | null> {
  return cacheGet<string>(CACHE_KEYS.whatsappQr(tenantId))
}

async function writeCachedQrCode(tenantId: string, qrCode: string): Promise<void> {
  await cacheSet(CACHE_KEYS.whatsappQr(tenantId), qrCode, CACHE_TTL_SECONDS.whatsappQr)
}

/** Pareou, caiu ou desligou: não há mais o que escanear. */
async function forgetQrCode(tenantId: string): Promise<void> {
  await cacheDelete(CACHE_KEYS.whatsappQr(tenantId))
}

// ─── Leitura para a tela ─────────────────────────────────────────────────────

export async function getConnection(tenantId: string): Promise<WhatsappConnection> {
  const { row, dailyCap } = await withTenant(tenantId, async (tx) => ({
    row: await readInstance(tx, tenantId),
    dailyCap: (await loadSettings(tx, tenantId)).dailyCap,
  }))

  const warmup = whatsappWarmupCap(dailyCap, row?.warmupStartedAt ?? null)

  // O QR só interessa enquanto se espera a leitura; pedi-lo em qualquer outro estado
  // seria uma ida ao Redis por batida do polling para receber `null`.
  const qrCode = row?.status === 'CONNECTING' ? await readCachedQrCode(tenantId) : null

  return {
    status: row?.status ?? 'NOT_CONFIGURED',
    phone: row?.phoneE164 ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
    // Não é persistido — vive no Redis, com TTL mais curto que o giro do provedor. O
    // banco guardaria um código vencido, e um QR velho na tela é pior que nenhum: a
    // pessoa fica tentando escanear o que já morreu, que foi exatamente o defeito que
    // fazia todo pareamento falhar antes desta correção.
    qrCode,
    lastError: row?.lastError ?? null,
    warmupDaysLeft: warmup.daysLeft,
    effectiveDailyCap: warmup.cap,
  }
}

// ─── Conectar ────────────────────────────────────────────────────────────────

function requireProvider(): void {
  if (!getEvolutionPort().configured) {
    throw providerUnavailable(
      'O canal WhatsApp não está configurado nesta instalação. Fale com quem administra o servidor.',
    )
  }
}

function webhookUrl(): string {
  const url = loadEnv().EVOLUTION_WEBHOOK_URL
  if (!url) {
    throw providerUnavailable(
      'Falta configurar o endereço de retorno da Evolution (EVOLUTION_WEBHOOK_URL)',
    )
  }
  return url
}

/**
 * AC-01: cria a instância e devolve o QR.
 *
 * Idempotente por um motivo prático: o admin clica em "Conectar", a rede engasga, ele
 * clica de novo. Se já existe instância, não se cria outra — pede-se um QR novo, que é
 * o mesmo caminho do AC-03. Recriar perderia a sessão e o `warmup_started_at`.
 */
export async function connectWhatsapp(
  actor: ActorContext,
  slug: string,
): Promise<WhatsappConnection & { qrCode: string | null }> {
  requireProvider()

  const existing = await withTenant(actor.tenantId, (tx) => readInstance(tx, actor.tenantId))
  if (existing && existing.status !== 'NOT_CONFIGURED') {
    return { ...(await refreshQrCode(actor)) }
  }

  const evolution = getEvolutionPort()
  const instanceName = existing?.instanceName ?? instanceNameFor(slug)
  const token = randomBytes(32).toString('base64url')

  // A linha vai ao banco **antes** de a instância existir no provedor, e a ordem é o
  // conserto de um defeito real: a Evolution dispara o primeiro `qrcode.updated` em
  // menos de um segundo, e quem descobre o tenant é o hash do token. Gravando depois,
  // esse callback chegava antes do commit, não encontrava linha nenhuma e levava 401 —
  // que a Evolution trata como definitivo e para de retentar.
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const data = {
        instanceName,
        provider: 'evolution',
        status: 'CONNECTING' as const,
        webhookTokenHash: hashToken(token),
        lastError: null,
      }
      await tx.whatsappInstance.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, ...data },
        update: data,
      })
    },
    tenantOptions(actor),
  )

  let created
  try {
    created = await evolution.createInstance({
      instanceName,
      webhookUrl: webhookUrl(),
      webhookToken: token,
    })
  } catch (error) {
    // Sem instância no provedor, a linha que acabou de ser gravada é pior que nada: o
    // próximo clique a encontraria em `CONNECTING` e cairia no `refreshQrCode`, que
    // exige a chave da instância e recusa — o dono ficaria trancado fora do pareamento
    // por um engasgo de rede. Apagar devolve a tela a "não conectado".
    await withTenant(actor.tenantId, (tx) =>
      tx.whatsappInstance.delete({ where: { tenantId: actor.tenantId } }),
    ).catch((cleanupError: unknown) => {
      logger.warn({ err: cleanupError, tenantId: actor.tenantId }, 'falha ao desfazer a instância')
    })
    throw toProviderError(error, 'Não foi possível criar a conexão no provedor')
  }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      const cipher = await openCipher(tx, actor.tenantId)
      await tx.whatsappInstance.update({
        where: { tenantId: actor.tenantId },
        data: { apiKeyEncrypted: cipher.encrypt(created.apiKey) },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'whatsapp_instance.connect',
        entity: 'whatsapp_instance',
        entityId: actor.tenantId,
        after: { instanceName, status: 'CONNECTING' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await invalidateCache(actor.tenantId)
  // O QR da criação é o corrente até o provedor girar; guardá-lo faz o polling da tela
  // já nascer com resposta, sem esperar o primeiro `qrcode.updated`.
  if (created.qrCode) await writeCachedQrCode(actor.tenantId, created.qrCode)

  return { ...(await getConnection(actor.tenantId)), qrCode: created.qrCode }
}

/**
 * AC-03: QR novo, **sem** recriar a instância.
 *
 * O QR da Evolution vence em cerca de um minuto. Recriar a instância a cada vencimento
 * daria um QR novo e jogaria fora o histórico da sessão junto — o AC diz "sem recriar"
 * exatamente por isso.
 */
export async function refreshQrCode(
  actor: ActorContext,
): Promise<WhatsappConnection & { qrCode: string | null }> {
  requireProvider()

  const credentials = await withTenant(actor.tenantId, async (tx) => {
    const row = await readInstance(tx, actor.tenantId)
    if (!row || !row.apiKeyEncrypted) return null
    const cipher = await openCipher(tx, actor.tenantId)
    return { instanceName: row.instanceName, apiKey: cipher.decrypt(row.apiKeyEncrypted) }
  })

  if (!credentials) {
    throw invalidTransition('Não há conexão de WhatsApp para reabrir. Conecte primeiro.')
  }

  let qrCode: string | null
  try {
    qrCode = await getEvolutionPort().requestQrCode(credentials.instanceName, credentials.apiKey)
  } catch (error) {
    throw toProviderError(error, 'Não foi possível pedir um novo QR code ao provedor')
  }

  // Pedir QR é declarar que ainda não pareou: se o estado no banco dizia outra coisa
  // (uma queda que o webhook não contou), ele volta para `CONNECTING`.
  await withTenant(actor.tenantId, (tx) =>
    tx.whatsappInstance.update({
      where: { tenantId: actor.tenantId },
      data: { status: 'CONNECTING', lastError: null },
    }),
  )
  await invalidateCache(actor.tenantId)
  if (qrCode) await writeCachedQrCode(actor.tenantId, qrCode)

  return { ...(await getConnection(actor.tenantId)), qrCode }
}

/**
 * Refazer a conexão do zero (recuperação).
 *
 * `connectWhatsapp` é idempotente e `refreshQrCode` reusa a instância — os dois de
 * propósito, porque recriar joga fora a sessão. Só que existe um estado do qual nenhum
 * dos dois sai: as chaves de identidade nascem na criação e sobrevivem a tudo, e quando
 * o WhatsApp passa a recusar **aquela identidade** — o que acontece depois de uma
 * sequência de registros negados — todo QR novo é recusado igual. O código muda, a
 * identidade não, e o petshop fica presa em "Aguardando leitura do QR" para sempre, com
 * o celular respondendo "não foi possível conectar, tente mais tarde" e nenhum erro
 * deste lado. Aconteceu em desenvolvimento, e a saída era `DELETE` na mão no provedor
 * mais um `delete` no banco: fora do alcance de quem usa o produto.
 *
 * É destrutivo e por isso não fica ao lado do botão comum: exige estar **fora** do
 * estado conectado, para que um clique errado não derrube uma sessão que funciona.
 */
export async function recreateWhatsapp(
  actor: ActorContext,
  slug: string,
): Promise<WhatsappConnection & { qrCode: string | null }> {
  requireProvider()

  const row = await withTenant(actor.tenantId, async (tx) => {
    const found = await readInstance(tx, actor.tenantId)
    if (!found) return null
    const cipher = await openCipher(tx, actor.tenantId)
    return {
      instanceName: found.instanceName,
      status: found.status,
      apiKey: found.apiKeyEncrypted ? cipher.decrypt(found.apiKeyEncrypted) : null,
    }
  })

  if (!row) {
    throw invalidTransition('Não há conexão de WhatsApp para refazer. Conecte primeiro.')
  }
  if (row.status === 'CONNECTED') {
    throw invalidTransition(
      'O WhatsApp está conectado. Desconecte antes de refazer a conexão do zero.',
    )
  }

  // O provedor é best-effort nos dois passos: se a instância já sumiu do lado de lá, ou
  // se ele está fora do ar, o que **precisa** acontecer é a linha sair daqui — senão o
  // clique seguinte encontra a identidade velha de novo e o petshop segue preso.
  const evolution = getEvolutionPort()
  const apiKey = row.apiKey
  if (apiKey) {
    try {
      await evolution.logout(row.instanceName, apiKey)
    } catch (error) {
      logger.warn({ err: error, tenantId: actor.tenantId }, 'logout antes de refazer falhou')
    }
    try {
      await evolution.deleteInstance(row.instanceName, apiKey)
    } catch (error) {
      logger.warn({ err: error, tenantId: actor.tenantId }, 'apagar a instância falhou')
    }
  }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await tx.whatsappInstance.delete({ where: { tenantId: actor.tenantId } })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'whatsapp_instance.recreate',
        entity: 'whatsapp_instance',
        entityId: actor.tenantId,
        before: { instanceName: row.instanceName, status: row.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await invalidateCache(actor.tenantId)
  await forgetQrCode(actor.tenantId)

  // Sem linha, `connectWhatsapp` cai no caminho de criação e o provedor gera chaves de
  // identidade novas — que é a coisa toda.
  return connectWhatsapp(actor, slug)
}

/** Desconectar a pedido do dono. A instância continua existindo, sem sessão. */
export async function disconnectWhatsapp(actor: ActorContext): Promise<WhatsappConnection> {
  const credentials = await withTenant(actor.tenantId, async (tx) => {
    const row = await readInstance(tx, actor.tenantId)
    if (!row || !row.apiKeyEncrypted) return null
    const cipher = await openCipher(tx, actor.tenantId)
    return { instanceName: row.instanceName, apiKey: cipher.decrypt(row.apiKeyEncrypted) }
  })

  if (!credentials) throw invalidTransition('Não há conexão de WhatsApp para desconectar')

  try {
    await getEvolutionPort().logout(credentials.instanceName, credentials.apiKey)
  } catch (error) {
    // O provedor pode estar fora, e o dono ainda assim quer o canal desligado. Gravar o
    // estado local é o que importa: sem sessão do lado de lá, nada sai de qualquer modo.
    logger.warn({ err: error, tenantId: actor.tenantId }, 'logout no provedor falhou')
  }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      await tx.whatsappInstance.update({
        where: { tenantId: actor.tenantId },
        data: { status: 'DISCONNECTED', lastError: null, connectedAt: null },
      })
      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'whatsapp_instance.disconnect',
        entity: 'whatsapp_instance',
        entityId: actor.tenantId,
        after: { status: 'DISCONNECTED' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await invalidateCache(actor.tenantId)
  await forgetQrCode(actor.tenantId)
  return getConnection(actor.tenantId)
}

// ─── Transições vindas do provedor ───────────────────────────────────────────

/**
 * AC-02: a sessão abriu.
 *
 * `warmup_started_at` é gravado **só na primeira vez**. Reconectar depois de uma queda
 * não reinicia o aquecimento: o número já é conhecido do WhatsApp, e zerar o contador a
 * cada oscilação de rede manteria o petshop preso a trinta mensagens por dia para
 * sempre.
 */
export async function markConnected(
  tenantId: string,
  phone: string | null,
  now = new Date(),
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.whatsappInstance.updateMany({
      where: { tenantId },
      data: {
        status: 'CONNECTED',
        phoneE164: phone,
        connectedAt: now,
        lastSeenAt: now,
        lastError: null,
      },
    }),
  )
  await withTenant(tenantId, (tx) =>
    tx.whatsappInstance.updateMany({
      where: { tenantId, warmupStartedAt: null },
      data: { warmupStartedAt: now },
    }),
  )
  await invalidateCache(tenantId)
}

/**
 * AC-04: a sessão caiu.
 *
 * Não mexe em mensagem nenhuma. O que impede a fila de virar cemitério é o
 * `dispatch.ts`, que devolve a `SCHEDULED` o que não pôde sair por canal fora — e é
 * assim que "três dias sem internet" custa três dias de atraso, não a fila inteira.
 */
export async function markDisconnected(tenantId: string, detail: string | null): Promise<void> {
  const row = await withTenant(tenantId, async (tx) => {
    const current = await readInstance(tx, tenantId)
    // Banimento é mais grave que queda: um `close` que chegue depois não o rebaixa.
    if (!current || current.status === 'BANNED') return null
    await tx.whatsappInstance.update({
      where: { tenantId },
      data: { status: 'DISCONNECTED', lastError: detail?.slice(0, 300) ?? null, lastSeenAt: new Date() },
    })
    return current
  })

  if (!row) return
  await invalidateCache(tenantId)

  if (row.status === 'CONNECTED') {
    // Só quando **era** conectado: um `close` sobre quem ainda está no QR é o estado
    // normal do pareamento, e avisar o MOD-ADMIN disso seria alarme falso.
    await publishEvent('whatsapp.desconectado', {
      tenantId,
      status: 'DISCONNECTED',
      phone: row.phoneE164,
      detail,
    })
  }
}

/**
 * AC-05: a Meta bloqueou o número.
 *
 * O canal é desligado para o tenant e as mensagens que esperavam por ele são
 * **devolvidas à fila sem canal escolhido**: a cascata de `resolveDelivery` roda de
 * novo no próximo despacho e leva ao e-mail quem tem endereço e consentimento. Não se
 * reescreve o destinatário aqui — quem sabe decidir canal é `recipient.ts`, e ter uma
 * segunda cópia dessa decisão é como as duas divergem.
 */
export async function markBanned(tenantId: string, detail: string | null): Promise<void> {
  const row = await withTenant(tenantId, async (tx) => {
    const current = await readInstance(tx, tenantId)
    if (!current || current.status === 'BANNED') return null
    await tx.whatsappInstance.update({
      where: { tenantId },
      data: { status: 'BANNED', lastError: detail?.slice(0, 300) ?? null, lastSeenAt: new Date() },
    })
    return current
  })

  if (!row) return
  await invalidateCache(tenantId)

  const moved = await fallbackPendingToEmail(tenantId)
  logger.error({ tenantId, movedToEmail: moved }, 'número de WhatsApp bloqueado pelo provedor')

  await publishEvent('whatsapp.banido', {
    tenantId,
    status: 'BANNED',
    phone: row.phoneE164,
    detail,
  })
}

/**
 * Move para o e-mail o que ainda não saiu (AC-05).
 *
 * Não é o mesmo que a queda de canal do AC-04, e a diferença é o prazo: um celular sem
 * internet volta hoje, e esperar é a resposta certa. Um número banido **não volta**, e
 * uma fila esperando por ele é uma fila que nunca escoa.
 *
 * **O corpo é reaproveitado, não re-renderizado.** As variáveis do template não são
 * guardadas na mensagem (RN-14: o texto é congelado na entrada da fila, não os dados
 * que o geraram), então não há como montar de novo o assunto personalizado. O assunto
 * passa a ser o rótulo do template — "Lembrete de agendamento" —, que é verdadeiro e
 * não vaza nome de tutor nem de pet num campo que aparece na lista da caixa de entrada.
 * O corpo, esse, o tutor recebe inteiro.
 *
 * Quem não tem e-mail com consentimento é **bloqueado**, e não apagado: a linha fica
 * com `NO_CHANNEL`/`NO_CONSENT` e o painel mostra por que aquela pessoa não recebeu.
 */
async function fallbackPendingToEmail(tenantId: string): Promise<number> {
  const pending = await withTenant(tenantId, (tx) =>
    tx.message.findMany({
      // `recipientKind: 'TUTOR'` não é redundância: mensagem de equipe nunca sai por
      // WhatsApp, e sem o filtro o `tutorId` desta consulta poderia vir nulo — o que o
      // `resolveDelivery` abaixo não sabe tratar.
      where: {
        channel: 'WHATSAPP',
        recipientKind: 'TUTOR',
        tutorId: { not: null },
        status: { in: ['QUEUED', 'SCHEDULED'] },
      },
      select: { id: true, tutorId: true, category: true, templateKey: true },
    }),
  )

  let moved = 0
  for (const message of pending) {
    await withTenant(tenantId, async (tx) => {
      const cipher = await openCipher(tx, tenantId)
      const decision = await resolveDelivery(tx, cipher, {
        tenantId,
        tutorId: message.tutorId as string,
        // `AUTO` e não `EMAIL`: a instância já está `BANNED`, então a cascata descarta o
        // WhatsApp sozinha. Pedir o e-mail pelo nome duplicaria essa decisão aqui.
        preference: 'AUTO',
        category: message.category,
      })

      if (!decision.ok) {
        await tx.message.update({
          where: { id: message.id },
          data: { status: 'BLOCKED', blockReason: decision.reason, scheduledFor: null },
        })
        return
      }

      const subject = findTemplateDefinition(message.templateKey)?.label ?? null
      await tx.message.update({
        where: { id: message.id },
        data: {
          channel: decision.delivery.channel,
          toEncrypted: cipher.encrypt(decision.delivery.address),
          toHash: hashSearchable(
            `messaging:${decision.delivery.channel.toLowerCase()}`,
            decision.delivery.address.toLowerCase(),
          ),
          subjectEncrypted: subject ? cipher.encrypt(subject) : null,
          // Não errou nada: foi o canal que morreu. Manter o backoff acumulado
          // atrasaria por horas um aviso que agora pode sair imediatamente.
          status: 'QUEUED',
          attempts: 0,
          scheduledFor: null,
          errorCode: null,
          errorDetail: null,
        },
      })
      moved += 1
    })
  }

  return moved
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/** Só os eventos que mudam estado; o resto é ignorado com 204. */
const CONNECTION_EVENTS = new Set(['connection.update', 'CONNECTION_UPDATE'])

/**
 * A troca de QR (AC-01).
 *
 * A Evolution roda o código a cada ~45s e avisa por aqui. Ignorar este evento — que era
 * o que se fazia — deixava na tela o primeiro QR para sempre: aos 45 segundos ele já
 * não existia do lado do provedor, e o WhatsApp respondia "não foi possível conectar,
 * tente mais tarde" sem que nenhum frame chegasse até nós. O sintoma não se parece com
 * defeito nosso, e é.
 */
const QRCODE_EVENTS = new Set(['qrcode.updated', 'QRCODE_UPDATED'])

interface WebhookPayload {
  event?: string
  instance?: string
  data?: {
    state?: string
    statusReason?: number | string
    wuid?: string
    qrcode?: {
      /** `data:image/png;base64,…` quando o webhook está com `base64: true`. */
      base64?: string
    }
  }
}

/**
 * O callback da Evolution (RN-11).
 *
 * Chega anônimo — quem descobre o tenant é `resolveWhatsappInstanceByTokenHash`, no
 * escopo de plataforma, porque saber de quem é a sessão **precede** o contexto de
 * tenant. Daqui para a frente tudo roda em `withTenant()`, como o resto do sistema.
 */
export async function applyWebhook(tenantId: string, payload: WebhookPayload): Promise<void> {
  const event = payload.event ?? ''

  if (QRCODE_EVENTS.has(event)) {
    const qrCode = payload.data?.qrcode?.base64
    // Só guarda o que dá para desenhar. Um evento sem imagem existe (o provedor avisa
    // do giro antes de ter o PNG) e substituir o QR bom por nada apagaria a tela.
    if (qrCode) await writeCachedQrCode(tenantId, qrCode)
    return
  }

  if (!CONNECTION_EVENTS.has(event)) return

  const state = payload.data?.state
  if (state === 'open') {
    // `wuid` chega como `5511988887777@s.whatsapp.net`.
    const phone = payload.data?.wuid ? `+${payload.data.wuid.split('@')[0]}` : null
    await markConnected(tenantId, phone)
    await forgetQrCode(tenantId)
    logger.info({ tenantId }, 'WhatsApp pareado')
    return
  }

  if (state === 'close') {
    const reason = payload.data?.statusReason
    // 401 do lado do WhatsApp é sessão derrubada pelo aparelho — pareamento perdido,
    // não bloqueio de conta. Um banimento se manifesta no envio, não aqui.
    await markDisconnected(tenantId, reason ? `Conexão encerrada (${reason})` : null)
    await forgetQrCode(tenantId)
  }
}

/** Confere o token do callback contra o hash guardado. */
export function webhookTokenHash(token: string): string {
  return hashToken(token)
}

function toProviderError(error: unknown, fallback: string): Error {
  if (error instanceof EvolutionRequestError) {
    // 4xx do provedor quase sempre é entrada nossa (nome de instância repetido, chave
    // errada); 5xx é ele. Os dois viram 502 para o admin, com o detalhe no problem+json
    // — quem opera o servidor precisa da frase original para saber onde olhar.
    return providerUnavailable(`${fallback}: ${error.message}`)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return providerUnavailable(`${fallback}: o provedor não respondeu a tempo`)
  }
  return error instanceof Error ? error : invalid(fallback)
}
