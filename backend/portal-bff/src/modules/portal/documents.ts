import { withTenant } from '@petshop/db'
import {
  DOCUMENT_URL_TTL_SECONDS,
  TERM_KINDS,
  termKindForChannel,
  type PortalDocument,
  type PortalTerm,
  type TermKind,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { signDocumentUrl } from '../../lib/document-urls.js'
import { notFound } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'

/**
 * Meus Documentos (MOD-DOC-10) e os termos que o tutor aceita no Portal (MOD-DOC-07).
 *
 * **A leitura é direta no banco**, como o resto do módulo: a lista é recorte de
 * `documents` por titularidade, e recorte é o que o BFF faz. Não há fan-out para os três
 * serviços que emitem documento — recibo, receituário e termo já estão na mesma tabela,
 * e pedir por HTTP o que a linha já diz seria rede por nada.
 *
 * **Assinar a URL também é leitura.** A chave do objeto está na linha que acabou de ser
 * lida sob RLS; assinar é cálculo local, sem ida ao bucket. O que **não** acontece aqui é
 * emitir: documento pendente continua pendente, e a tela diz "em preparo". Quem renderiza
 * e arquiva é o serviço que sabe montar cada tipo, e é lá que o job de reprocesso mora.
 *
 * **O aceite do termo é escrita, e por isso vai por HTTP** (`tutor-port.ts`), como toda
 * escrita na ficha: é o tutor-service que valida a versão vigente, grava a prova
 * append-only com IP e user-agent, emite o papel e escreve a trilha.
 */

/**
 * Os documentos do titular, do mais recente para o mais antigo.
 *
 * `PENDING` entra na lista **sem URL**: o tutor vê que o recibo do pagamento de agora há
 * pouco está a caminho, em vez de achar que ele não existe. `CANCELLED` e `FAILED` ficam
 * de fora — um é papel sem efeito, o outro é problema do estabelecimento.
 *
 * A listagem **não assina nada**, e é a mesma regra do Admin: abrir a lista não é baixar
 * dez arquivos, e a trilha registra download, não navegação.
 */
export async function listOwnDocuments(
  tenantId: string,
  tutorId: string,
): Promise<PortalDocument[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.document.findMany({
      where: { tutorId, status: { in: ['PENDING', 'ISSUED'] } },
      select: {
        id: true,
        kind: true,
        number: true,
        status: true,
        issuedAt: true,
        petId: true,
        createdAt: true,
      },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })

    const petIds = [...new Set(rows.flatMap((row) => (row.petId ? [row.petId] : [])))]
    const pets =
      petIds.length > 0
        ? await tx.pet.findMany({ where: { id: { in: petIds } }, select: { id: true, name: true } })
        : []
    const nomePorPet = new Map(pets.map((pet) => [pet.id, pet.name]))

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      number: row.number,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      petName: row.petId ? (nomePorPet.get(row.petId) ?? null) : null,
      ready: row.status === 'ISSUED',
    }))
  })
}

/**
 * A URL assinada de um documento — e pedi-la **é** o download (§9).
 *
 * AC-02: o documento de outro titular responde **404**, exatamente como o que não
 * existe. O recorte é `tutorId` na consulta, e não uma comparação depois de ler: o que
 * não é dele nunca chega a sair do banco.
 */
export async function readOwnDocument(
  tenantId: string,
  tutorId: string,
  documentId: string,
  actor: {
    actorUserId?: string | null
    ipAddress?: string | undefined
    userAgent?: string | undefined
  },
): Promise<{ url: string | null; number: string }> {
  const row = await withTenant(tenantId, (tx) =>
    tx.document.findFirst({
      where: { id: documentId, tutorId, status: { in: ['PENDING', 'ISSUED'] } },
      select: { number: true, kind: true, storageKey: true },
    }),
  )

  if (!row) throw notFound('Documento não encontrado')

  const url = await signDocumentUrl(row.storageKey, DOCUMENT_URL_TTL_SECONDS)

  if (url) {
    await withTenant(tenantId, (tx) =>
      recordAudit(tx, {
        tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'document.downloaded',
        entity: 'document',
        entityId: documentId,
        // `documentNumber`, e não `number`: `number` está na lista de chaves sensíveis
        // do `service-kit` (é o número do endereço) e chegaria à trilha redigido.
        after: { kind: row.kind, documentNumber: row.number, source: 'PORTAL' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      }),
    ).catch((error: unknown) => {
      // O endereço já foi assinado; falhar a resposta por causa da trilha faria o tutor
      // perder o documento por um problema que não é dele. Fica o log.
      logger.error({ err: error, documentId }, 'falha ao registrar o download do documento')
    })
  }

  return { url, number: row.number }
}

// ─── Os termos (MOD-DOC-07 AC-02 e MOD-DOC-08) ───────────────────────────────

/**
 * Os termos vigentes e o que este tutor já aceitou.
 *
 * O texto e o estado saem da **mesma leitura**: a tela precisa dos dois para decidir
 * entre "leia o que você aceitou" e "aceite para continuar", e duas chamadas para montar
 * uma tela de três cartões seriam duas viagens no 4G de quem está na calçada.
 *
 * A vigência é a versão publicada mais recente, como no Admin — não há uma coluna que
 * diga "esta é a atual" (MOD-DOC-06).
 */
export async function listOwnTerms(tenantId: string, tutorId: string): Promise<PortalTerm[]> {
  return withTenant(tenantId, async (tx) => {
    const [versions, consents] = await Promise.all([
      tx.termVersion.findMany({ orderBy: { publishedAt: 'desc' } }),
      tx.tutorConsent.findMany({
        where: { tutorId },
        select: { channel: true, granted: true, version: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    // A última transição de cada canal é o estado — derivar, e não guardar, é o que
    // torna impossível o estado divergir da prova append-only.
    const ultimo = new Map<TermKind, { granted: boolean; version: string }>()
    for (const consent of consents) {
      const kind = termKindForChannel(consent.channel)
      // Canal de contato também cita a versão do termo de uso; o que interessa aqui é o
      // aceite do próprio texto, e por isso só o canal homônimo conta.
      if (consent.channel !== kind) continue
      ultimo.set(kind, { granted: consent.granted, version: consent.version })
    }

    return TERM_KINDS.flatMap((kind) => {
      const vigente = versions.find((item) => item.kind === kind)
      if (!vigente) return []

      const aceite = ultimo.get(kind)

      return [
        {
          kind,
          title: vigente.title,
          version: vigente.version,
          body: vigente.body,
          accepted: aceite?.granted === true && aceite.version === vigente.version,
          acceptedVersion: aceite?.granted === true ? aceite.version : null,
        } satisfies PortalTerm,
      ]
    })
  })
}

/**
 * O tutor aceita o termo pelo Portal.
 *
 * A prova precisa dizer que o aceite veio **daqui**, e não do balcão: `source = PORTAL`
 * é fixado na porta, nunca aceito do cliente, pela mesma razão que `purpose` já era. O
 * IP e o user-agent viajam nos headers e são gravados do outro lado — sem eles, a linha
 * registraria o endereço do contêiner do BFF.
 */
export async function acceptOwnTerm(
  caller: TutorCaller,
  tutorId: string,
  kind: TermKind,
): Promise<void> {
  await getTutorPort().acceptTerm(caller, tutorId, kind)
}
