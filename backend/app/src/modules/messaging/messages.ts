import { hashSearchable, withTenant, type TenantTransaction } from '@petshop/db'
import {
  findTemplateDefinition,
  type EnqueueMessageInput,
  type MessageBlockReason,
  type MessageCategory,
  type MessageChannel,
  type MessageOriginType,
  type MessageRecipientKind,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import {
  invalid,
  invalidTransition,
  messagingDisabled,
  notFound,
  unknownTemplate,
} from './errors.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { openCipher, type MessageCipher } from './crypto.js'
import { dispatchTenant } from './dispatch.js'
import { render } from './render.js'
import { marketingCapReached } from './frequency.js'
import {
  adminUrlOf,
  documentsUrlOf,
  portalUrlOf,
  siteUrlOf,
  subscriptionUrlOf,
} from './attachments.js'
import { resolveDelivery, resolveOverrideDelivery, resolveUserDelivery } from './recipient.js'
import { resolveTemplate } from './templates.js'
import { loadSettings } from './settings.js'
import { nextOpening } from './window.js'

/**
 * O enfileiramento — a única porta de entrada do envio (§5 do PRD).
 *
 * Cinco decisões acontecem aqui, nesta ordem, e a ordem importa:
 *
 * 1. **O motor está ligado?** Desligado recusa (RN-13) em vez de acumular.
 * 2. **Já pedi isso?** `dedupeKey` devolve a mensagem existente sem criar outra.
 * 3. **Para onde e por qual canal?** A cascata de `recipient.ts`, que pode bloquear.
 * 4. **Com que texto?** Renderizado **agora** (RN-14), com os dados deste instante.
 * 5. **Quando pode sair?** A janela de silêncio, que agenda em vez de descartar.
 *
 * E, entre a 4 e a 5, a RN-08: **cabe dentro de uma mensagem que ainda não saiu?**
 */

/**
 * RN-08 — a janela de agrupamento.
 *
 * Cinco minutos. Curto porque o objetivo não é economizar mensagem, é não parecer um
 * robô: o caso que o AC-02 de MOD-CRM-09 nomeia é o taxi entregar o pet e o
 * atendimento ser concluído no mesmo minuto, e o tutor receber duas notificações
 * seguidas sobre o mesmo fato.
 */
const MERGE_WINDOW_MS = 5 * 60_000

export interface EnqueueResult {
  id: string
  status: string
  /** `true` quando o `dedupeKey` já existia — o chamador recebe 200, não 201. */
  duplicate: boolean
  /**
   * Por que não vai sair, quando `status` é `BLOCKED`.
   *
   * Existe para a campanha: ela precisa registrar em `campaign_targets` **por que**
   * aquela pessoa ficou de fora, e sem este campo teria de refazer, do lado dela, as
   * mesmas quatro perguntas que a cascata de `recipient.ts` acabou de responder — com a
   * garantia de as duas divergirem no primeiro motivo novo.
   */
  blockReason: MessageBlockReason | null
}

/**
 * Variáveis que o motor resolve sozinho.
 *
 * Todo chamador precisaria delas e nenhum deveria ter de buscá-las: o nome do petshop
 * e o do tutor são de quem envia e de quem recebe, não do assunto da mensagem.
 */
async function baseVariables(
  tx: TenantTransaction,
  recipient: Recipient,
  documentId: string | null,
): Promise<Record<string, string>> {
  const [tenant, settings] = await Promise.all([
    tx.tenant.findFirst({ select: { name: true, slug: true } }),
    // O telefone público entrou em `tenant_settings` com o perfil do tenant
    // (2026-08-28). Antes dele esta variável renderizava vazio, e toda mensagem saía
    // dizendo "avise pelo " — a frase ficava de pé, mas sem o número que a justifica.
    tx.tenantSettings.findFirst({ select: { publicPhone: true, publicWhatsapp: true } }),
  ])

  const slug = tenant?.slug ?? ''
  const common = {
    'petshop.nome': tenant?.name ?? '',
    // O WhatsApp na frente do fixo: quem recebe a mensagem por WhatsApp responde por
    // ele, e o template diz "fale com a gente" — não "ligue".
    'petshop.telefone': settings?.publicWhatsapp ?? settings?.publicPhone ?? '',
    /**
     * Os três endereços da instalação (AC-02 de MOD-NOTIF-08).
     *
     * Montados de `APP_DOMAIN` em tempo de execução, e não de constante cravada. É o
     * mesmo bug que já mordeu uma vez, quando `.petshopai.app` estava fixo no
     * onboarding e em `/configuracoes`: o admin lia um endereço que não existia.
     */
    'petshop.link_admin': adminUrlOf(),
    'petshop.link_site': siteUrlOf(slug),
    'petshop.link_portal': portalUrlOf(slug),
    /**
     * O endereço do documento entra **aqui**, no enfileiramento, e é o que mantém a
     * promessa do AC-05 de MOD-NOTIF-05: o corpo cifrado nunca conhece uma URL
     * assinada.
     *
     * O que se oferece é a página "Meus Documentos" do Portal — pública, estável, e que
     * pede a sessão do tutor do outro lado. A URL assinada do bucket vive quinze minutos
     * e é credencial: no corpo, ela estaria no histórico, no log do provedor e na caixa
     * de entrada, que são três lugares onde credencial não vai.
     */
    ...(documentId && recipient.kind === 'TUTOR'
      ? { 'documento.link': documentsUrlOf(slug) }
      : {}),
  }

  /**
   * O nome de quem recebe sai de tabelas diferentes, e as marcações também.
   *
   * `tutor.*` e `usuario.*` não são sinônimos com nomes distintos: são as duas relações
   * que a instância única do Clerk aproxima e que o produto precisa manter separadas.
   * Um texto de equipe que dissesse "Olá, tutor" seria exatamente o vazamento de
   * enquadramento que o MOD-NOTIF existe para evitar.
   */
  if (recipient.kind === 'USER') {
    const user = await tx.user.findUnique({
      where: { id: recipient.userId },
      select: { fullName: true },
    })
    const fullName = user?.fullName ?? ''
    return {
      ...common,
      'usuario.nome': fullName,
      'usuario.primeiro_nome': fullName.split(/\s+/)[0] ?? '',
      /**
       * A tela da assinatura, resolvida aqui como os outros três endereços.
       *
       * Quem publica o aviso da conta é o módulo de identidade e o webhook do Asaas, e
       * nenhum dos dois tem — nem deveria ter — a função que monta URL de superfície do
       * produto. Só para a equipe: o cliente final não assina nada.
       */
      'conta.link_assinatura': subscriptionUrlOf(),
      /**
       * O padrão de "onde se paga" é a mesma tela, e quem tem a cobrança em aberto
       * sobrescreve com o link dela. Sem este padrão, o aviso de atraso de quem assinou
       * no cartão — onde não há boleto nem PIX para apontar — sairia com a frase de pé e
       * o endereço faltando.
       */
      'conta.link_pagamento': subscriptionUrlOf(),
    }
  }

  const tutor = await tx.tutor.findUnique({
    where: { id: recipient.tutorId },
    select: { fullName: true },
  })
  const fullName = tutor?.fullName ?? ''
  return {
    ...common,
    'tutor.nome': fullName,
    'tutor.primeiro_nome': fullName.split(/\s+/)[0] ?? '',
  }
}

/**
 * O destinatário, já desambiguado (MOD-NOTIF-01).
 *
 * União discriminada e não dois campos opcionais, porque a diferença entre os dois é
 * grande demais para ser um `if` espalhado: chave de criptografia, gates, tabela de
 * origem do nome e canal disponível mudam todos junto. O schema Zod já garantiu que
 * exatamente um veio; o tipo é o que impede o resto do arquivo de esquecer disso.
 */
type Recipient =
  | { kind: 'TUTOR'; tutorId: string }
  | { kind: 'USER'; userId: string }

function recipientOf(input: EnqueueMessageInput): Recipient {
  // O `as string` é o que o `.refine()` do schema já garantiu: `recipientKind` e o id
  // correspondente chegam juntos, ou a requisição nem passou da validação.
  return input.recipientKind === 'USER'
    ? { kind: 'USER', userId: input.userId as string }
    : { kind: 'TUTOR', tutorId: input.tutorId as string }
}

/**
 * Encaixa o texto novo numa mensagem irmã que ainda não saiu, e devolve o id dela.
 *
 * As condições são estreitas de propósito. Mesmo tutor, mesmo canal e **mesma
 * categoria**: juntar um aviso de taxi (OPERATIONAL, que atravessa a janela de
 * silêncio) com uma oferta (MARKETING, que não atravessa) faria a oferta sair às sete
 * da manhã pendurada na carona do aviso. E só o que ainda está em `QUEUED`/`SCHEDULED`
 * — quem já foi para `SENDING` tem a lease do worker e pode estar no ar neste instante.
 *
 * O `UPDATE ... WHERE status IN (...)` é o que fecha a corrida: se o worker reivindicar
 * a irmã entre a leitura e a escrita, nenhuma linha é afetada e a mensagem nova segue
 * sozinha. Perder um agrupamento é aceitável; concatenar num corpo que já saiu, não.
 */
async function absorbIntoRecent(
  tx: TenantTransaction,
  cipher: MessageCipher,
  input: {
    tenantId: string
    tutorId: string
    channel: MessageChannel
    category: MessageCategory
    body: string
    now: Date
  },
): Promise<string | null> {
  const sibling = await tx.message.findFirst({
    where: {
      tutorId: input.tutorId,
      channel: input.channel,
      category: input.category,
      direction: 'OUTBOUND',
      status: { in: ['QUEUED', 'SCHEDULED'] },
      createdAt: { gte: new Date(input.now.getTime() - MERGE_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, bodyEncrypted: true },
  })
  if (!sibling) return null

  let merged: string
  try {
    merged = `${cipher.decrypt(sibling.bodyEncrypted)}\n\n${input.body}`
  } catch {
    // Corpo ilegível (expurgado pela retenção, ou de outra chave): não dá para
    // concatenar no escuro. A mensagem nova segue sozinha, que é a queda segura.
    return null
  }

  const { count } = await tx.message.updateMany({
    where: { id: sibling.id, status: { in: ['QUEUED', 'SCHEDULED'] } },
    data: { bodyEncrypted: cipher.encrypt(merged) },
  })

  return count === 1 ? sibling.id : null
}

export async function enqueueMessage(
  actor: ActorContext,
  input: EnqueueMessageInput,
): Promise<EnqueueResult> {
  const definition = findTemplateDefinition(input.templateKey)
  if (!definition) {
    throw unknownTemplate(`Não existe um texto chamado "${input.templateKey}"`)
  }
  const category: MessageCategory = definition.category
  const recipient = recipientOf(input)
  const recipientKind: MessageRecipientKind = recipient.kind

  /**
   * AC-03 de MOD-NOTIF-02 — marketing não se dirige à equipe.
   *
   * É a mesma linha que a guarda do `overrideAddress` já não cruza, e recusar aqui em
   * vez de bloquear no despacho é deliberado: mandar oferta a um funcionário não é um
   * tutor que não quer receber, é um chamador que errou o destinatário. E o gate que
   * pegaria isso mais tarde — o consentimento — nem roda para `USER`.
   */
  if (recipientKind === 'USER' && category === 'MARKETING') {
    throw invalid('Texto de marketing não pode ser enviado a um membro da equipe')
  }

  /**
   * Equipe sai por e-mail, e só.
   *
   * O produto não tem o WhatsApp do funcionário — o número que ele porventura tenha
   * cadastrado é o de tutor, de outra relação, e mandar recado de trabalho para ele
   * seria misturar as duas que a instância única do Clerk já aproxima. Recusar é melhor
   * que cair para o e-mail em silêncio: quem pediu WhatsApp precisa saber que não houve.
   */
  if (recipientKind === 'USER' && input.channel === 'WHATSAPP') {
    throw invalid('Mensagem para a equipe sai por e-mail; o WhatsApp é do cliente')
  }

  /**
   * As duas guardas do destino imposto (ver `resolveOverrideDelivery`).
   *
   * Ficam aqui, antes da transação, porque são erro **do chamador** e não estado do
   * tenant: quem pediu para mandar promoção a um endereço fora da ficha errou o pedido,
   * e a resposta certa é 422 e não uma mensagem `BLOCKED` que ninguém vai investigar.
   *
   * `MARKETING` é a linha que não se cruza. Sem ela, este campo seria um caminho para
   * enviar oferta a qualquer endereço digitado, sem consentimento e sem ficha — o
   * contrário exato do que o MOD-CRM defende.
   *
   * Ela foi escrita antes de existir texto de `MARKETING` no catálogo, quando não tinha
   * como disparar. Desde a fatia 3 do MOD-CRM tem: aniversário, convite de volta e
   * campanha entraram em `messaging-seed.ts`, e a guarda passou a valer sozinha, sem
   * ninguém precisar lembrar deste arquivo enquanto escrevia o outro.
   */
  if (input.overrideAddress) {
    if (recipientKind === 'USER') {
      // O convite de equipe é o único destinatário do sistema sem `user_id` — e ele
      // ficou fora da v1 (MOD-NOTIF-12). Enquanto não migrar, endereço imposto é coisa
      // de tutor, e aceitar aqui abriria o caminho antes de haver quem o usasse.
      throw invalid('Contato fora da ficha não se aplica a mensagem de equipe')
    }
    if (category === 'MARKETING') {
      throw invalid('Texto de marketing não pode ser enviado para um contato fora da ficha')
    }
    if (input.channel === 'AUTO') {
      throw invalid('Informe o canal ao enviar para um contato fora da ficha')
    }
  }

  // Explícito pela mesma razão do `dispatch.ts`: as duas saídas — já existia, ou
  // acabou de nascer — não têm os mesmos campos, e a união inferida os tornaria todos
  // opcionais.
  type Enqueued =
    | { id: string; status: string; duplicate: true; blockReason: MessageBlockReason | null }
    | {
        id: string
        status: string
        duplicate: false
        channel: MessageChannel
        blockReason: MessageBlockReason | null
        scheduledFor: Date | null
      }

  // Um único instante para a janela de silêncio e para a de agrupamento: duas leituras
  // do relógio na mesma operação podem cair em minutos diferentes, e é o tipo de
  // diferença que só aparece na virada.
  const now = new Date()

  const result: Enqueued = await withTenant(
    actor.tenantId,
    async (tx) => {
      const settings = await loadSettings(tx, actor.tenantId)
      /**
       * AC-04 de MOD-NOTIF-02 — o interruptor é sobre falar com o **cliente**.
       *
       * `enabled` nasce falso, e é assim de propósito: quem responde pelo número do
       * petshop decide quando o disparo começa. Mas o e-mail de boas-vindas do próprio
       * onboarding é dirigido ao administrador, e barrá-lo aqui desligaria justamente a
       * mensagem que ensina a ligar o motor.
       */
      if (!settings.enabled && recipientKind === 'TUTOR') throw messagingDisabled()

      const existing = await tx.message.findUnique({
        where: { tenantId_dedupeKey: { tenantId: actor.tenantId, dedupeKey: input.dedupeKey } },
        select: { id: true, status: true, blockReason: true },
      })
      if (existing) {
        return {
          id: existing.id,
          status: existing.status,
          duplicate: true,
          blockReason: existing.blockReason,
        }
      }

      const cipher = await openCipher(tx, actor.tenantId)
      const decision = recipient.kind === 'USER'
        ? await resolveUserDelivery(tx, { tenantId: actor.tenantId, userId: recipient.userId })
        : input.overrideAddress
        ? await resolveOverrideDelivery(tx, {
            tenantId: actor.tenantId,
            // O `input.channel !== 'AUTO'` já foi exigido acima; o `as` só convence o
            // compilador do que a guarda garantiu.
            channel: input.channel as MessageChannel,
            address: input.overrideAddress,
          })
        : await resolveDelivery(tx, cipher, {
            tenantId: actor.tenantId,
            tutorId: recipient.kind === 'TUTOR' ? recipient.tutorId : '',
            preference: input.channel === 'AUTO' ? settings.defaultChannel : input.channel,
            category,
          })

      /**
       * O teto semanal do tutor, cobrado **aqui** e não no despacho.
       *
       * É a diferença entre este teto e o diário do tenant, e ela é deliberada. O teto
       * diário **adia**: a mensagem cabe amanhã, e o petshop quer que caiba. Este
       * **recusa**: a oferta que não coube nesta semana não vira a oferta da semana que
       * vem — quando chegar lá haverá outra campanha, e a antiga sairia atrasada,
       * competindo com a nova pela mesma cota.
       *
       * O resultado é uma linha `BLOCKED` com o motivo, que é o que permite à campanha
       * dizer por que aquela pessoa ficou de fora em vez de simplesmente não aparecer.
       */
      const overWeeklyCap =
        decision.ok &&
        // AC-01 de MOD-NOTIF-02: o teto protege **o tutor**, que é quem cansa de
        // receber oferta. Não há oferta para a equipe — a guarda acima já recusou.
        recipient.kind === 'TUTOR' &&
        category === 'MARKETING' &&
        (await marketingCapReached(tx, {
          tutorId: recipient.tutorId,
          cap: settings.marketingWeeklyCap,
          now,
        }))

      const channel: MessageChannel = decision.ok ? decision.delivery.channel : decision.channel
      const address = decision.ok ? decision.delivery.address : ''

      const template = await resolveTemplate(tx, input.templateKey, channel)
      if (!template) throw unknownTemplate(`Não existe um texto chamado "${input.templateKey}"`)

      const variables = {
        ...(await baseVariables(tx, recipient, input.documentId ?? null)),
        ...input.variables,
      }
      const body = render(template.body, variables)
      const subject = template.subject ? render(template.subject, variables).text : null

      if (body.missing.length > 0) {
        // Não impede o envio: um template que perdeu uma variável ainda comunica o
        // essencial, e barrar aqui silenciaria o lembrete inteiro por um campo vazio.
        // Mas o log precisa dizer, porque é assim que se descobre um template errado.
        logger.warn(
          { templateKey: input.templateKey, missing: body.missing },
          'template renderizado com variáveis sem valor',
        )
      }

      /**
       * A janela é do tutor: mesmo um `scheduledFor` pedido pelo chamador é empurrado
       * para a próxima abertura se cair na madrugada.
       *
       * **E é só dele** (AC-01 de MOD-NOTIF-02). A janela de silêncio existe para não
       * incomodar um cliente em casa às onze da noite; um convite de equipe represado
       * até as oito da manhã é um convite quebrado, e quem o espera está com a tela
       * aberta agora. `scheduledFor` explícito continua valendo para os dois — quem
       * pediu hora sabe o que quer.
       */
      const opening =
        recipient.kind === 'USER'
          ? null
          : nextOpening(input.scheduledFor ?? now, category, {
              quietStartMin: settings.quietStartMin,
              quietEndMin: settings.quietEndMin,
              marketingWeekdaysOnly: settings.marketingWeekdaysOnly,
              timezone: settings.timezone,
            })
      const scheduledFor = opening ?? input.scheduledFor ?? null

      const blocked = !decision.ok || overWeeklyCap
      const blockReason: MessageBlockReason | null = !decision.ok
        ? decision.reason
        : overWeeklyCap
          ? 'WEEKLY_CAP'
          : null

      /**
       * RN-08: cabe dentro de uma mensagem que ainda não saiu?
       *
       * `urgent` sai fora do agrupamento, e é a exceção que o código de acesso do
       * Portal exige. Absorver um código de seis dígitos dentro de outro texto o
       * entrega no meio de um lembrete de banho — quando entrega; a irmã pode estar
       * agendada para depois de ele expirar.
       *
       * `overrideAddress` sai pelo motivo mais duro dos dois: a irmã está endereçada ao
       * contato **da ficha**, e este texto vai para outro. Agrupar mandaria o código do
       * telefone novo para o telefone antigo, que é a única entrega capaz de aprovar a
       * troca sem prova nenhuma. Hoje nenhum chamador chega aqui — o único texto que usa
       * o campo é `urgent` —, e a guarda existe para o segundo.
       */
      const absorbedBy =
        blocked ||
        input.urgent ||
        input.overrideAddress ||
        Boolean(input.documentId) ||
        recipient.kind === 'USER'
          ? null
          : await absorbIntoRecent(tx, cipher, {
              tenantId: actor.tenantId,
              tutorId: recipient.tutorId,
              channel,
              category,
              body: body.text,
              now,
            })

      const created = await tx.message.create({
        data: {
          tenantId: actor.tenantId,
          recipientKind,
          tutorId: recipient.kind === 'TUTOR' ? recipient.tutorId : null,
          userId: recipient.kind === 'USER' ? recipient.userId : null,
          petId: input.petId ?? null,
          documentId: input.documentId ?? null,
          channel,
          category,
          templateKey: input.templateKey,
          templateVersion: template.version,
          toEncrypted: cipher.encrypt(address),
          toHash: hashSearchable(`messaging:${channel.toLowerCase()}`, address.toLowerCase()),
          subjectEncrypted: subject ? cipher.encrypt(subject) : null,
          bodyEncrypted: cipher.encrypt(body.text),
          status: blocked
            ? 'BLOCKED'
            : absorbedBy
              ? 'MERGED'
              : scheduledFor
                ? 'SCHEDULED'
                : 'QUEUED',
          blockReason,
          dedupeKey: input.dedupeKey,
          originType: input.originType ?? null,
          originId: input.originId ?? null,
          // Absorvida não tem horário próprio: quem carrega o texto é a irmã, e um
          // `scheduled_for` aqui faria o worker tentar despachá-la.
          scheduledFor: blocked || absorbedBy ? null : scheduledFor,
          mergedIntoId: absorbedBy,
          requestedBy: actor.actorUserId ?? null,
        },
        select: { id: true, status: true },
      })

      return {
        id: created.id,
        status: created.status,
        duplicate: false,
        channel,
        blockReason,
        scheduledFor: blocked ? null : scheduledFor,
      }
    },
    tenantOptions(actor),
  )

  // Publicação **pós-commit**, como todo evento deste sistema: a mensagem já está no
  // banco, e uma falha de broker não pode desfazê-la.
  if (!result.duplicate) {
    if (result.blockReason) {
      await publishEvent('mensagem.bloqueada', {
        tenantId: actor.tenantId,
        messageId: result.id,
        recipientKind,
        tutorId: input.tutorId ?? null,
        userId: input.userId ?? null,
        channel: result.channel,
        category,
        blockReason: result.blockReason,
      })
    } else {
      await publishEvent('mensagem.enfileirada', {
        tenantId: actor.tenantId,
        messageId: result.id,
        recipientKind,
        tutorId: input.tutorId ?? null,
        userId: input.userId ?? null,
        channel: result.channel,
        category,
        templateKey: input.templateKey,
        scheduledFor: result.scheduledFor?.toISOString() ?? null,
      })
    }
  }

  /**
   * Despacho na mesma requisição, para a mensagem que não sobrevive à fila.
   *
   * O worker varre a cada minuto, e um código de dez minutos que sai no sétimo já
   * chegou tarde para quem está com a tela aberta esperando. `dispatchTenant` é o mesmo
   * passo que o job daria — sem jitter, porque o jitter existe para espalhar disparo de
   * campanha, e aqui há uma mensagem só, pedida por uma pessoa.
   *
   * Falha aqui **não** vira erro do chamador: a mensagem está gravada e enfileirada, e
   * o worker a pega no minuto seguinte. Perder a resposta do `enqueue` por causa do
   * despacho seria trocar um atraso por uma falha.
   */
  if (input.urgent && !result.duplicate && !result.blockReason) {
    await dispatchTenant(actor.tenantId, { jitter: false }).catch((error: unknown) => {
      logger.error({ err: error, tenantId: actor.tenantId }, 'falha no despacho imediato')
    })
  }

  return {
    id: result.id,
    status: result.status,
    duplicate: result.duplicate,
    blockReason: result.blockReason,
  }
}

/**
 * Cancela o que ainda não saiu, pelo que a originou (AC-06 de MOD-CRM-03).
 *
 * É o que impede o lembrete de amanhã de sair depois do agendamento cancelado hoje às
 * 20h. Devolve quantas foram canceladas, para o chamador logar.
 */
export async function cancelByOrigin(
  tenantId: string,
  originType: MessageOriginType,
  originId: string,
): Promise<number> {
  const { count } = await withTenant(tenantId, (tx) =>
    tx.message.updateMany({
      where: { originType, originId, status: { in: ['QUEUED', 'SCHEDULED'] } },
      data: { status: 'CANCELLED' },
    }),
  )
  return count
}

export async function cancelMessage(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const message = await tx.message.findUnique({ where: { id }, select: { status: true } })
      if (!message) throw notFound()
      if (message.status !== 'QUEUED' && message.status !== 'SCHEDULED') {
        throw invalidTransition(
          `Esta mensagem está em ${message.status} e não pode mais ser cancelada`,
        )
      }
      await tx.message.update({ where: { id }, data: { status: 'CANCELLED' } })
    },
    tenantOptions(actor),
  )
}

/**
 * Reenvio manual de uma mensagem morta (AC-02 de MOD-CRM-11).
 *
 * Volta para `QUEUED` com o contador zerado — e o motor **revalida consentimento e
 * supressão no despacho** (RN-03). Reenvio não é atalho para furar bloqueio: quem
 * pediu para não receber continua não recebendo, e a mensagem vira `BLOCKED` de novo.
 *
 * **`SENDING` também entra**, e não é uma frouxidão da guarda. Ele parece um envio em
 * curso e quase nunca é: o estado dura os segundos de uma chamada ao provedor, e o
 * varredor de posses o desfaz em dez minutos. Quem o encontra numa tela é sempre o
 * dono de uma mensagem cujo processo morreu no meio, e recusá-lo deixava essa pessoa
 * sem saída nenhuma — o reenvio negava, o varredor ainda não existia, e a linha ficava
 * parada para sempre. O risco de mandar duas vezes o que o provedor já aceitou é o
 * mesmo do varredor, e a diferença é que aqui alguém escolheu correr esse risco.
 */
export async function retryMessage(actor: ActorContext, id: string): Promise<void> {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const message = await tx.message.findUnique({ where: { id }, select: { status: true } })
      if (!message) throw notFound()
      if (
        message.status !== 'DEAD' &&
        message.status !== 'FAILED' &&
        message.status !== 'SENDING'
      ) {
        throw invalidTransition(
          `Só mensagens com falha podem ser reenviadas (esta está em ${message.status})`,
        )
      }

      await tx.message.update({
        where: { id },
        data: {
          status: 'QUEUED',
          attempts: 0,
          scheduledFor: null,
          errorCode: null,
          errorDetail: null,
          failedAt: null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'message.retried',
        entity: 'messages',
        entityId: id,
        before: { status: message.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}
