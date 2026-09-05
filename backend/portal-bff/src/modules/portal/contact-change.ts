import { withTenant, normalizeEmail, type TenantTransaction } from '@petshop/db'
import {
  PORTAL_CONTACT_CHANGE_TTL_MIN,
  PORTAL_MAX_ATTEMPTS,
  maskPortalTarget,
  normalizePhoneBR,
  portalChannelOfField,
  type PortalContactChangeInput,
  type PortalContactChangeResponse,
  type PortalContactField,
  type PortalContactVerifyInput,
  type PortalMeDataResponse,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import {
  contactInUse,
  invalid,
  invalidCode,
  notFound,
  tooManyAttempts,
} from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { recordSecurityEvent } from '../../lib/security-events.js'
import type { ActorContext } from './actor.js'
import {
  codeMatches,
  generateCode,
  hashCode,
  hashIdentifier,
  hashTutorEmail,
  hashTutorPhone,
  openCipher,
} from './crypto.js'
import { readOwnData } from './me-data.js'
import { getMessagingPort } from './messaging-port.js'
import { checkChallengeRate } from './rate-limit.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'

/**
 * MOD-PORTAL-09, AC-02 — trocar telefone ou e-mail exige provar a posse do **novo**.
 *
 * **Por que este arquivo não reaproveita `challenge.ts`.** Os dois mandam seis dígitos e
 * param aí. Aquele é construído inteiro em torno da resposta uniforme do RN-04: grava
 * linha até para identificador que não casa com ficha nenhuma, iguala o tempo de resposta
 * e nunca diz o que aconteceu — porque do outro lado pode estar alguém varrendo a base
 * para descobrir quem é cliente do petshop. Aqui não há nada disso a esconder: quem pede
 * já está autenticado e já é dono da ficha. Herdar o disfarce custaria as mensagens de
 * erro que fazem a tela ser usável, e em troca de proteção nenhuma.
 *
 * **Por que a prova é obrigatória.** Telefone e e-mail são as chaves de identidade
 * (RN-13 de `tutores_02`): é por eles que o MOD-PORTAL-01 encontra a ficha, e é para eles
 * que a cobrança é enviada. Uma sessão esquecida aberta num celular emprestado bastaria
 * para apontar a ficha inteira — histórico, extrato, endereço — para o contato de outra
 * pessoa. O código não impede a sessão esquecida; impede que ela **mude o dono da ficha**.
 *
 * O código vai para o endereço novo, e é a única forma que prova alguma coisa: mandá-lo
 * para o contato antigo provaria a posse justamente do contato que está sendo trocado.
 */

export interface ContactChangeRequest {
  actor: ActorContext
  caller: TutorCaller
  tutorId: string
  input: PortalContactChangeInput
}

export interface ContactVerifyRequest {
  actor: ActorContext
  caller: TutorCaller
  tutorId: string
  input: PortalContactVerifyInput
}

/**
 * O valor digitado, normalizado para a forma em que o tutor-service o grava.
 *
 * Sem isto, `+55 11 98765-4321` e `11987654321` produziriam hashes diferentes, e a
 * checagem de duplicata nunca casaria — o sintoma seria dois tutores com o mesmo telefone
 * e a busca do balcão encontrando um só.
 */
function normalizeContact(field: PortalContactField, raw: string): string {
  if (field === 'EMAIL') {
    const email = normalizeEmail(raw)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw invalid('E-mail inválido')
    }
    return email
  }

  try {
    return normalizePhoneBR(raw)
  } catch {
    throw invalid('Telefone inválido. Informe DDD e número.')
  }
}

function hashContact(field: PortalContactField, normalized: string): string {
  return field === 'EMAIL' ? hashTutorEmail(normalized) : hashTutorPhone(normalized)
}

// ─── Pedir o código ──────────────────────────────────────────────────────────

export async function requestContactChange(
  request: ContactChangeRequest,
): Promise<PortalContactChangeResponse> {
  const { actor, tutorId, input } = request

  const normalized = normalizeContact(input.field, input.value)
  const channel = portalChannelOfField(input.field)
  const valueHash = hashContact(input.field, normalized)

  /**
   * O mesmo teto do desafio de acesso, e pela mesma razão.
   *
   * A ação cara e abusável é **mandar mensagem**, não descobrir ficha. Um tutor
   * autenticado que dispare cem trocas de telefone gasta cem WhatsApps do petshop, e o
   * limite por identificador cobre isso sem precisar de contador próprio. A chave é do
   * valor **novo**, então uma sessão legítima trocando o próprio número nunca esbarra no
   * cooldown que outra pessoa causou.
   */
  const verdict = await checkChallengeRate(
    actor.tenantId,
    hashIdentifier(normalized),
    actor.ipAddress ?? null,
  )
  if (verdict !== 'OK') {
    throw tooManyAttempts('Muitas tentativas. Aguarde alguns minutos e tente de novo.')
  }

  const code = generateCode()

  const changeId = await withTenant(actor.tenantId, async (tx) => {
    const cipher = await openCipher(tx, actor.tenantId)

    const tutor = await tx.tutor.findFirst({
      where: { id: tutorId, anonymizedAt: null, deletedAt: null },
      select: { id: true, phoneHash: true, emailHash: true },
    })
    if (!tutor) throw notFound()

    // Já é este o contato: não há o que provar, e mandar um código faria a tela pedir
    // confirmação de uma mudança que não existe.
    const atual = input.field === 'EMAIL' ? tutor.emailHash : tutor.phoneHash
    if (atual === valueHash) {
      throw invalid('Este já é o seu contato cadastrado.')
    }

    await assertContactFree(tx, input.field, valueHash, tutorId)

    /**
     * O pedido anterior morre, e não coexiste.
     *
     * Dois desafios abertos para o mesmo tutor fariam o código antigo continuar valendo
     * depois de a pessoa ter corrigido um dígito errado — e o valor que entraria na ficha
     * seria o do primeiro, não o do último. Consumir em vez de apagar preserva a trilha.
     */
    await tx.portalContactChange.updateMany({
      where: { tutorId, consumedAt: null },
      data: { consumedAt: new Date() },
    })

    const row = await tx.portalContactChange.create({
      data: {
        tenantId: actor.tenantId,
        tutorId,
        field: input.field,
        channel,
        pendingValueEncrypted: cipher.encrypt(normalized),
        pendingValueHash: valueHash,
        codeHash: '',
        expiresAt: new Date(Date.now() + PORTAL_CONTACT_CHANGE_TTL_MIN * 60_000),
        ipAddress: actor.ipAddress ?? null,
      },
      select: { id: true },
    })

    // O hash depende do id da linha, então a gravação é em dois passos — o mesmo desenho
    // de `challenge.ts`. Sem o id no HMAC, o mesmo código valeria em pedidos diferentes.
    await tx.portalContactChange.update({
      where: { id: row.id },
      data: { codeHash: hashCode(row.id, code) },
    })

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'portal.contact_change_requested',
      entity: 'portal_contact_change',
      entityId: row.id,
      // O valor novo **não** entra na trilha: ele ainda não é dado da ficha, e a linha
      // ficaria guardando em claro um contato que a pessoa pode nem confirmar.
      after: { tutorId, field: input.field, channel },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })

    return row.id
  })

  /**
   * O envio fica **fora** da transação.
   *
   * Falha de mensageria não pode desfazer a linha: o rate limit já contou o pedido, e um
   * rollback aqui daria ao tutor uma tentativa de graça a cada indisponibilidade do
   * WhatsApp. Quem não recebe o código pede outro em um minuto.
   */
  const enviado = await getMessagingPort().sendContactCode({
    tenantId: actor.tenantId,
    tutorId,
    channel,
    address: normalized,
    code,
    dedupeKey: `portal-contact:${changeId}`,
  })
  if (!enviado) {
    logger.error({ tutorId, channel }, 'não foi possível enviar o código de troca de contato')
  }

  return {
    changeId,
    field: input.field,
    channel,
    // Do que a pessoa digitou, e não do banco: é o mesmo desenho do desafio de acesso, e
    // aqui é ainda mais direto — o valor não está gravado em lugar nenhum.
    maskedTarget: maskPortalTarget(normalized, channel),
    expiresInMin: PORTAL_CONTACT_CHANGE_TTL_MIN,
  }
}

/**
 * O contato novo já é de outra ficha deste petshop?
 *
 * A resposta **não diz de quem**, nem confirma que a outra ficha existe: manda procurar o
 * petshop. Confirmar "este telefone já é de alguém aqui" devolveria ao Portal o poder de
 * oráculo que o RN-04 tirou dele na porta de entrada — só que agora consultável em lote,
 * por quem tem uma sessão válida.
 *
 * Nenhum outro lugar faz esta checagem: o `warnOnProbableDuplicate` do tutor-service roda
 * só na **criação** do tutor, e o `PATCH` que esta troca acaba chamando não olha telefone
 * repetido. Se ela sair daqui, sai do sistema.
 */
async function assertContactFree(
  tx: TenantTransaction,
  field: PortalContactField,
  valueHash: string,
  tutorId: string,
): Promise<void> {
  const outro = await tx.tutor.findFirst({
    where: {
      id: { not: tutorId },
      ...(field === 'EMAIL' ? { emailHash: valueHash } : { phoneHash: valueHash }),
      deletedAt: null,
      anonymizedAt: null,
      status: { not: 'MERGED' },
    },
    select: { id: true },
  })

  if (outro) throw contactInUse()
}

// ─── Consumir o código ───────────────────────────────────────────────────────

export async function verifyContactChange(
  request: ContactVerifyRequest,
): Promise<PortalMeDataResponse> {
  const { actor, caller, tutorId, input } = request

  /**
   * A tentativa errada é contada **antes**, em transação própria.
   *
   * Contá-la no mesmo `withTenant` que lança desfaz a contagem: o throw rola a transação
   * para trás e `attempts` volta a zero. O teto de cinco nunca dispararia, e o sintoma
   * seria força bruta funcionando com o código do teto no lugar, aparentemente correto —
   * o mesmo defeito que `verify.ts` documenta para o desafio de acesso.
   */
  await registerAttempt(request)

  const applied = await withTenant(actor.tenantId, async (tx) => {
    const cipher = await openCipher(tx, actor.tenantId)

    const change = await tx.portalContactChange.findFirst({
      where: { id: input.changeId, tenantId: actor.tenantId },
    })

    /**
     * Pedido inexistente, de outro tutor, consumido, bloqueado ou vencido: **a mesma
     * resposta** do código errado.
     *
     * Aqui a uniformidade não é anti-enumeração — é que nenhuma dessas distinções ajuda
     * quem está digitando. Todas terminam em "peça um código novo".
     */
    if (
      !change ||
      change.tutorId !== tutorId ||
      change.consumedAt !== null ||
      change.blocked ||
      change.expiresAt.getTime() < Date.now()
    ) {
      throw invalidCode()
    }

    if (!codeMatches(change.codeHash, hashCode(change.id, input.code))) {
      // A contagem já foi gravada por `registerAttempt`, fora desta transação.
      throw invalidCode()
    }

    /**
     * A duplicata é conferida **de novo**, e não é paranoia.
     *
     * Entre pedir o código e digitá-lo passam-se minutos, e a recepção pode ter cadastrado
     * naquele intervalo um tutor com este mesmo telefone. A checagem do pedido garante que
     * o contato estava livre; só esta garante que ele **está**.
     */
    await assertContactFree(tx, change.field, change.pendingValueHash, tutorId)

    await tx.portalContactChange.update({
      where: { id: change.id },
      data: { consumedAt: new Date() },
    })

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'portal.contact_change_verified',
      entity: 'portal_contact_change',
      entityId: change.id,
      after: { tutorId, field: change.field },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })

    return { field: change.field, value: cipher.decrypt(change.pendingValueEncrypted) }
  })

  /**
   * A gravação na ficha vai pela porta, **fora** da transação que consumiu o código.
   *
   * A ordem é deliberada: o código morre primeiro. Se o tutor-service estiver fora do ar,
   * o tutor recebe um erro e pede outro código — irritante, e recuperável. A ordem
   * inversa deixaria um código vivo depois de a ficha já ter mudado, e o mesmo dígito
   * valeria uma segunda vez.
   */
  await getTutorPort().applyContactChange(
    caller,
    tutorId,
    applied.field === 'EMAIL' ? { email: applied.value } : { phone: applied.value },
  )

  return readOwnData(actor.tenantId, tutorId)
}

/** Conta a tentativa e, no quinto erro, mata o pedido. */
async function registerAttempt(request: ContactVerifyRequest): Promise<void> {
  const { actor, tutorId, input } = request

  const exhausted = await withTenant(actor.tenantId, async (tx) => {
    const change = await tx.portalContactChange.findFirst({
      where: {
        id: input.changeId,
        tenantId: actor.tenantId,
        tutorId,
        consumedAt: null,
        blocked: false,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, codeHash: true, attempts: true },
    })
    if (!change) return null
    if (codeMatches(change.codeHash, hashCode(change.id, input.code))) return null

    const attempts = change.attempts + 1
    const esgotou = attempts >= PORTAL_MAX_ATTEMPTS

    await tx.portalContactChange.update({
      where: { id: change.id },
      data: { attempts, ...(esgotou ? { blocked: true, consumedAt: new Date() } : {}) },
    })

    return esgotou ? { changeId: change.id, attempts } : null
  })

  if (!exhausted) return

  /**
   * **Sem cooldown por identificador**, ao contrário do desafio de acesso.
   *
   * Lá o cooldown existe porque o atacante pode pedir um código novo e recomeçar a
   * contagem — cinco tentativas por pedido, sem limite de pedidos, é não ter teto. Aqui
   * pedir outro código já passa pelo `checkChallengeRate`, que conta três por quinze
   * minutos no mesmo valor. O teto já está posto, e um segundo travaria também o **acesso**
   * de quem esbarrou nele apenas trocando o próprio telefone.
   */
  await recordSecurityEvent({
    tenantId: actor.tenantId,
    type: 'LOGIN_FAILED',
    targetEntity: 'portal_contact_change',
    targetId: exhausted.changeId,
    ipAddress: actor.ipAddress ?? null,
    metadata: { reason: 'CONTACT_CODE_BRUTE_FORCE', attempts: exhausted.attempts, tutorId },
  })

  throw tooManyAttempts('Muitas tentativas. Peça um código novo.')
}
