import { getMaintenancePrisma, withTenant, type TenantTransaction } from '@petshop/db'
import {
  createPendingDocument,
  issueDocument,
  loadIssuer,
  missingIssuerFields,
} from '@petshop/documents'
import {
  DOCUMENT_MAX_ATTEMPTS,
  DOCUMENT_URL_TTL_SECONDS,
  TERM_DOCUMENT_KINDS,
  TERM_KIND_LABELS,
  TUTOR_ROUTING_KEYS,
  consentChannelForTerm,
  maskCNPJ,
  maskCPF,
  type AcceptTermInput,
  type ConsentSource,
  type DocumentKind,
  type DocumentStatus,
  type DocumentView,
  type TermAcceptanceView,
  type TermKind,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import {
  documentDataMissing,
  notFound,
  termAlreadyAccepted,
  termVersionUnknown,
} from '../tutors/errors.js'
import { publishEvent } from '../../shared/events.js'
import { logger, recordMetric } from '../../shared/logger.js'
import { isPdfConfigured, renderPdf } from './pdf-port.js'
import { documentStorage, getStorage } from '../../shared/document-storage.js'
import { invalidateTutor } from '../../shared/redis.js'
import { decryptOptional, openCipher, type TutorCipher } from '../tutors/crypto.js'
import { assertWritable, type ActorContext } from '../tutors/service.js'
import { currentTermVersion } from './service.js'
import { renderTermAcceptanceHtml, type TermAcceptanceData } from './template.js'

/**
 * O aceite do termo (MOD-DOC-07) e a autorização de uso de imagem (MOD-DOC-08).
 *
 * **Não há assinatura desenhada em tela nem papel digitalizado.** A prova é a que
 * `tutor_consents` já guarda desde o MOD-TUTOR: versão do termo, IP, user-agent, origem
 * e carimbo de tempo, numa tabela append-only por trigger **e** por REVOKE — nem
 * `app_user` nem `app_maintenance` têm UPDATE nela. Isso vale mais, juridicamente, que
 * um rabisco num tablet, funciona igual no balcão e no Portal, e não exige comprar
 * hardware para cada recepção.
 *
 * O que este módulo acrescenta ao que já existia é o **papel**: o documento que mostra
 * qual texto foi apresentado, a quem, quando e de onde. O ciclo é o mesmo do recibo e do
 * receituário — número dentro da transação, arquivo depois, `PENDING` no meio.
 *
 * **A revogação não passa por aqui.** Continua sendo o `PUT /v1/tutors/:id/consents`, e
 * o PDF do aceite original continua arquivado (AC-05): revogar é fato novo, não
 * apagamento do fato anterior — o documento prova o que valia enquanto valia.
 */

const SOURCE_LABELS: Record<ConsentSource, string> = {
  STAFF_FORM: 'Balcão do estabelecimento',
  PORTAL: 'Portal do cliente',
  SITE: 'Site do estabelecimento',
  WHATSAPP: 'WhatsApp',
  IMPORT: 'Importação de cadastro',
  // Nunca aparece num termo — a origem existe para a revogação por reclamação de spam
  // (AC-02 de MOD-NOTIF-10). Fica aqui porque o mapa é exaustivo de propósito: é o
  // typecheck que obriga a decidir o rótulo quando uma origem nova nasce.
  PROVIDER: 'Reclamação no provedor de e-mail',
}

export interface AcceptTermResult {
  acceptance: TermAcceptanceView
  /** Falso quando o aceite já existia e só faltava o papel. A rota devolve 200. */
  created: boolean
}

export async function acceptTerm(
  actor: ActorContext,
  tutorId: string,
  input: AcceptTermInput,
  source: ConsentSource = 'STAFF_FORM',
): Promise<AcceptTermResult> {
  const acceptedAt = new Date()
  const channel = consentChannelForTerm(input.kind)
  const documentKind = TERM_DOCUMENT_KINDS[input.kind]

  const registrado = await withTenant(
    actor.tenantId,
    async (tx) => {
      const tutor = await tx.tutor.findFirst({ where: { id: tutorId, deletedAt: null } })
      if (!tutor) throw notFound()
      assertWritable(tutor)

      const term = await currentTermVersion(tx, input.kind)

      /**
       * A versão citada tem de ser a vigente.
       *
       * Um cliente que manda a versão está provando **qual texto exibiu**; se o que ele
       * exibiu não é o de hoje, o aceite descreveria uma tela desatualizada. Recusar é
       * o que faz o campo servir para alguma coisa.
       */
      if (input.version && input.version !== term.version) {
        throw termVersionUnknown(
          `A versão ${input.version} não é a vigente de ${TERM_KIND_LABELS[input.kind].toLowerCase()}. Recarregue o termo e apresente o texto atual.`,
        )
      }

      const ultimo = await tx.tutorConsent.findFirst({
        where: { tutorId, channel },
        orderBy: { createdAt: 'desc' },
        select: { id: true, granted: true, version: true, documentId: true, createdAt: true },
      })

      /**
       * AC-03 — aceite repetido na mesma versão não vira linha nova.
       *
       * Com uma exceção que o PRD não previa e o cadastro obriga: o visto de "aceito os
       * termos" e o de uso de imagem do formulário de tutor já gravam consentimento
       * desde o MOD-TUTOR, e **sem papel** — emitir documento durante a criação exigiria
       * o endereço completo do estabelecimento e derrubaria o cadastro de quem ainda não
       * o preencheu. Quando a prova já existe e o papel não, este caminho emite só o
       * papel, sem sujar a tabela append-only com uma segunda linha idêntica.
       */
      const jaAceito = ultimo?.granted === true && ultimo.version === term.version
      if (jaAceito && (ultimo.documentId || !documentKind)) {
        throw termAlreadyAccepted(
          `Este tutor já aceitou a versão ${term.version} de ${TERM_KIND_LABELS[input.kind].toLowerCase()}`,
        )
      }

      const cipher = await openCipher(tx, actor.tenantId)
      const contexto = await loadContext(tx, actor.tenantId, tutorId, cipher, tutor)

      let document: { id: string; number: string } | null = null
      if (documentKind) {
        const faltando = missingIssuerFields(contexto.issuer)
        if (faltando.length > 0) {
          // AC-02 de MOD-DOC-01: a resposta diz **qual** dado falta. Tenants criados
          // antes de 2026-08-28 estão sem endereço, e é por aqui que eles descobrem.
          throw documentDataMissing(
            `Complete o cadastro do estabelecimento antes de emitir documentos: ${faltando.join(', ')}`,
          )
        }

        document = await createPendingDocument(tx, actor.tenantId, {
          kind: documentKind,
          tutorId,
          createdBy: actor.actorUserId ?? null,
          reference: acceptedAt,
        })
      }

      /**
       * A linha nasce com `document_id` preenchido, e não recebe o valor depois: a
       * tabela é append-only, e uma coluna que precisasse de UPDATE para chegar ao valor
       * certo simplesmente não caberia nela.
       */
      const consent = jaAceito
        ? ultimo
        : await tx.tutorConsent.create({
            data: {
              tenantId: actor.tenantId,
              tutorId,
              channel,
              granted: true,
              // O termo não é preferência de comunicação: vale para os dois propósitos,
              // como o `TERMS` do cadastro já gravava.
              purpose: 'BOTH',
              version: term.version,
              source,
              ipAddress: actor.ipAddress ?? null,
              userAgent: actor.userAgent ?? null,
              documentId: document?.id ?? null,
              createdAt: acceptedAt,
            },
            select: { id: true, granted: true, version: true, documentId: true, createdAt: true },
          })

      if (jaAceito && document) {
        /**
         * A prova já existia e o papel não. Não dá para pendurar o documento na linha
         * antiga — ela é imutável —, então a ligação fica só do lado do documento, que
         * já aponta para o tutor. É por `tutor_id` que a lista do MOD-DOC-10 filtra.
         */
        logger.info(
          { tutorId, kind: input.kind, documentId: document.id },
          'papel emitido para aceite que já existia',
        )
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'term.accepted',
        entity: 'tutor_consent',
        entityId: consent.id,
        after: {
          kind: input.kind,
          version: term.version,
          source,
          // `documentNumber`, e não `number`: `number` está na lista de chaves sensíveis
          // do `service-kit` (é o número do endereço) e chegaria à trilha como
          // `[redacted]` — justamente o dado que o §9 manda registrar.
          documentNumber: document?.number ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return {
        consent,
        document,
        created: !jaAceito,
        payload:
          document && documentKind
            ? ({
                number: document.number,
                issuer: contexto.issuer,
                timezone: contexto.timezone,
                kind: input.kind,
                termTitle: term.title,
                termVersion: term.version,
                termBody: term.body,
                tutorName: contexto.tutorName,
                tutorDocument: contexto.tutorDocument,
                petNames: contexto.petNames,
                acceptedAt,
                ipAddress: actor.ipAddress ?? null,
                userAgent: actor.userAgent ?? null,
                sourceLabel: SOURCE_LABELS[source],
              } satisfies TermAcceptanceData)
            : null,
        version: term.version,
      }
    },
    actor.actorUserId ? { userId: actor.actorUserId } : {},
  )

  await invalidateTutor(actor.tenantId, tutorId)

  let status: DocumentStatus | null = null
  if (registrado.document && registrado.payload) {
    const outcome = await issueDocument(deps(actor), {
      tenantId: actor.tenantId,
      documentId: registrado.document.id,
      kind: TERM_DOCUMENT_KINDS[input.kind] as DocumentKind,
      html: renderTermAcceptanceHtml(registrado.payload),
      title: TERM_KIND_LABELS[input.kind],
      number: registrado.document.number,
    })
    status = outcome.status
  }

  await publishEvent(TUTOR_ROUTING_KEYS.tutorTermoAceito, {
    tenantId: actor.tenantId,
    tutorId,
    kind: input.kind,
    version: registrado.version,
    documentId: registrado.document?.id ?? null,
  })
  recordMetric({
    metric: 'tutor_term_accepted_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return {
    created: registrado.created,
    acceptance: {
      consentId: registrado.consent.id,
      kind: input.kind,
      version: registrado.version,
      acceptedAt: registrado.consent.createdAt.toISOString(),
      documentId: registrado.document?.id ?? null,
      documentNumber: registrado.document?.number ?? null,
      documentStatus: status,
    },
  }
}

// ─── Os papéis do tutor ──────────────────────────────────────────────────────

/**
 * Os documentos de aceite de um tutor.
 *
 * A listagem **não** assina URL nenhuma: abrir a aba de consentimento não é baixar o
 * termo, e a trilha do §9 registra download — não navegação. Uma lista que assinasse
 * dez arquivos geraria dez linhas de acesso que ninguém pediu e afogaria as que importam.
 *
 * O filtro é por `tutor_id`, e não por tipo: um tipo de documento novo entra na lista
 * sozinho, e nenhum vaza por esquecimento (AC-03 de MOD-DOC-10).
 */
export async function listTutorDocuments(
  tenantId: string,
  tutorId: string,
): Promise<DocumentView[]> {
  return withTenant(tenantId, async (tx) => {
    const tutor = await tx.tutor.findFirst({ where: { id: tutorId }, select: { id: true } })
    if (!tutor) throw notFound()

    const rows = await tx.document.findMany({
      where: { tutorId, status: { in: ['PENDING', 'ISSUED'] } },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      number: row.number,
      status: row.status,
      tutorId: row.tutorId,
      petId: row.petId,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      url: null,
    }))
  })
}

/**
 * Um documento, com a URL assinada — e pedi-la **é** o download (§9).
 *
 * Se o arquivo ainda não existir, tenta gerar na hora: quem clicou está esperando, e o
 * job de dez em dez minutos é a rede de segurança, não o caminho feliz.
 */
export async function getTutorDocument(
  actor: ActorContext,
  tutorId: string,
  documentId: string,
): Promise<DocumentView> {
  let row = await loadDocument(actor.tenantId, tutorId, documentId)

  if (row.status === 'PENDING' && isPdfConfigured()) {
    await issuePendingTermDocument(actor.tenantId, documentId).catch((error: unknown) => {
      // Falhar aqui deixaria quem clicou sem resposta. O documento continua pendente e
      // a tela diz "em preparo".
      logger.warn({ err: error, documentId }, 'falha ao emitir termo sob demanda')
    })
    row = await loadDocument(actor.tenantId, tutorId, documentId)
  }

  if (row.storageKey) {
    await withTenant(
      actor.tenantId,
      (tx) =>
        recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'document.downloaded',
          entity: 'document',
          entityId: documentId,
          after: { kind: row.kind, documentNumber: row.number },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        }),
      actor.actorUserId ? { userId: actor.actorUserId } : {},
    )
  }

  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    status: row.status,
    tutorId: row.tutorId,
    petId: row.petId,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    url: row.storageKey
      ? await getStorage().signedUrl(row.storageKey, DOCUMENT_URL_TTL_SECONDS)
      : null,
  }
}

async function loadDocument(tenantId: string, tutorId: string, documentId: string) {
  const row = await withTenant(tenantId, (tx) =>
    tx.document.findFirst({ where: { id: documentId, tutorId } }),
  )
  // O filtro por `tutorId` é o que impede que a rota da ficha de um tutor sirva o
  // documento de outro — a permissão é a mesma para os dois.
  if (!row) throw notFound('Documento não encontrado')
  return row
}

// ─── Reprocesso (MOD-DOC-11) ─────────────────────────────────────────────────

interface PendingRow {
  id: string
  tenant_id: string
}

/**
 * O job de reprocesso: os aceites cujo papel o Gotenberg não conseguiu gerar na hora.
 *
 * A varredura sai de `documents` porque é lá que moram `attempts` e `last_error` — o
 * orçamento de tentativas é do documento. E o `WHERE` recorta pelos dois tipos deste
 * serviço: recibo e receituário são reprocessados por quem sabe montá-los.
 */
export async function retryPendingTermDocuments(
  now: Date = new Date(),
): Promise<{ issued: number }> {
  const rows = await getMaintenancePrisma().$queryRaw<PendingRow[]>`
    SELECT d.id, d.tenant_id
      FROM documents d
     WHERE d.status = 'PENDING'
       AND d.kind IN ('TERM_ACCEPTANCE', 'IMAGE_CONSENT')
       AND d.attempts < ${DOCUMENT_MAX_ATTEMPTS}
       AND d.created_at <= ${now}
     ORDER BY d.created_at ASC
     LIMIT 200
  `

  let issued = 0
  for (const row of rows) {
    try {
      const result = await issuePendingTermDocument(row.tenant_id, row.id)
      if (result.issued) issued += 1
    } catch (error) {
      // Um termo que não pôde ser emitido não derruba os outros 199.
      logger.error({ err: error, documentId: row.id }, 'falha ao reprocessar termo')
    }
  }

  return { issued }
}

/**
 * Remonta o documento a partir do que está gravado e tenta arquivar de novo.
 *
 * O texto vem da **versão que o consentimento cita**, e não da vigente: o papel precisa
 * dizer o que era verdade no dia, mesmo que o job rode depois de uma publicação nova.
 * É o mesmo motivo pelo qual o CRMV do receituário é snapshot.
 */
export async function issuePendingTermDocument(
  tenantId: string,
  documentId: string,
): Promise<{ issued: boolean; status: DocumentStatus }> {
  const dados = await withTenant(tenantId, async (tx) => {
    const document = await tx.document.findFirst({
      where: { id: documentId, kind: { in: ['TERM_ACCEPTANCE', 'IMAGE_CONSENT'] } },
      include: { consent: true },
    })
    if (!document?.tutorId) return null

    /**
     * O tipo sai do **documento**, e não do consentimento, porque nem todo papel tem uma
     * linha apontando para ele: o aceite colhido no cadastro grava a prova sem documento,
     * e quando o papel é emitido depois, a linha já é imutável e não recebe a ligação.
     * `TERM_ACCEPTANCE` é sempre responsabilidade — o termo de uso não emite papel.
     */
    const kind: TermKind =
      document.kind === 'IMAGE_CONSENT' ? 'IMAGE_USE' : 'SERVICE_LIABILITY'

    /**
     * Sem a ligação, vale o último aceite daquele canal. É o mesmo fato: o papel foi
     * pedido para a autorização que está valendo, e é a data dela que ele carimba.
     */
    const consent =
      document.consent ??
      (await tx.tutorConsent.findFirst({
        where: { tutorId: document.tutorId, channel: kind, granted: true },
        orderBy: { createdAt: 'desc' },
      }))

    // Documento de termo sem aceite nenhum é registro órfão: fabricar a prova a partir
    // do papel seria inventar o que ele deveria provar.
    if (!consent) return null

    const term = await tx.termVersion.findFirst({
      where: { kind, version: consent.version },
    })
    if (!term) return null

    const tutor = await tx.tutor.findFirst({ where: { id: document.tutorId } })
    if (!tutor) return null

    const cipher = await openCipher(tx, tenantId)
    const contexto = await loadContext(tx, tenantId, document.tutorId, cipher, tutor)

    return {
      documentId: document.id,
      number: document.number,
      documentKind: document.kind,
      payload: {
        number: document.number,
        issuer: contexto.issuer,
        timezone: contexto.timezone,
        kind,
        termTitle: term.title,
        termVersion: term.version,
        termBody: term.body,
        tutorName: contexto.tutorName,
        tutorDocument: contexto.tutorDocument,
        petNames: contexto.petNames,
        acceptedAt: consent.createdAt,
        ipAddress: consent.ipAddress,
        userAgent: consent.userAgent,
        sourceLabel: SOURCE_LABELS[consent.source],
      } satisfies TermAcceptanceData,
    }
  })

  if (!dados) return { issued: false, status: 'PENDING' }

  const outcome = await issueDocument(deps({ tenantId }), {
    tenantId,
    documentId: dados.documentId,
    kind: dados.documentKind,
    html: renderTermAcceptanceHtml(dados.payload),
    title: TERM_KIND_LABELS[dados.payload.kind],
    number: dados.number,
  })

  return { issued: outcome.status === 'ISSUED', status: outcome.status }
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

function deps(actor: { tenantId: string; actorUserId?: string | undefined }) {
  return {
    renderPdf,
    storage: documentStorage,
    logger,
    tenantOptions: actor.actorUserId ? { userId: actor.actorUserId } : {},
  }
}

interface AcceptanceContext {
  issuer: Awaited<ReturnType<typeof loadIssuer>>['issuer']
  timezone: string
  tutorName: string
  tutorDocument: string | null
  petNames: string[]
}

/**
 * O que a folha precisa saber sobre quem aceitou.
 *
 * O documento sai **mascarado** (`123.***.***-01`), como toda saída de tutor deste
 * serviço: o papel identifica a pessoa para quem já a conhece, e não é lugar de publicar
 * CPF inteiro — ele circula em grupo de WhatsApp junto com o resto.
 *
 * Os animais entram porque o texto do termo fala em "o animal identificado nesta folha".
 * O consentimento é do tutor, e não do pet — é o que a tabela append-only permite —,
 * então a folha lista os animais **do dia do aceite**. Um pet que chega depois entra na
 * folha seguinte.
 */
async function loadContext(
  tx: TenantTransaction,
  tenantId: string,
  tutorId: string,
  cipher: TutorCipher,
  tutor: { fullName: string; cpfEncrypted: string | null; cnpjEncrypted: string | null },
): Promise<AcceptanceContext> {
  const { issuer, timezone } = await loadIssuer(tx, tenantId)

  const links = await tx.petTutor.findMany({
    where: { tutorId, unlinkedAt: null, pet: { deletedAt: null } },
    select: { pet: { select: { name: true, status: true } } },
    take: 50,
  })

  const cpf = decryptOptional(cipher, tutor.cpfEncrypted)
  const cnpj = decryptOptional(cipher, tutor.cnpjEncrypted)

  return {
    issuer,
    timezone,
    tutorName: tutor.fullName,
    tutorDocument: cpf ? maskCPF(cpf) : cnpj ? maskCNPJ(cnpj) : null,
    petNames: links
      .filter((link) => link.pet.status !== 'TRANSFERRED_OUT')
      .map((link) => link.pet.name)
      .sort((a, b) => a.localeCompare(b, 'pt-BR')),
  }
}
