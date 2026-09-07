import { z } from 'zod'
import type { DocumentKind } from './document.js'
import type { ConsentChannel } from './tutor.js'

/**
 * Termos versionados (MOD-DOC-06, 07 e 08).
 *
 * A descoberta que dá origem a este arquivo: `CURRENT_TERMS_VERSION = '1.0'` estava
 * cravada em `tutor.ts` desde o MOD-TUTOR, e **toda** linha de `tutor_consents` gravava
 * essa versão como prova. O sistema registrava, com IP, user-agent e carimbo de tempo,
 * o aceite de um documento que não existia em lugar nenhum — nem para o tutor reler,
 * nem para o petshop provar o que apresentou.
 *
 * O texto passa a ser dado (`term_versions`), por tenant e por versão. A constante
 * continua existindo como o número da versão que a plataforma semeia, e é por isso que
 * ela vale **retroativamente**: o parque inteiro já aceitou a `1.0`, e a `1.0` agora
 * tem texto.
 */

/**
 * Que documento se aceita.
 *
 * São os três canais de `tutor_consents` que descrevem um texto, e não um meio de
 * contato. `WHATSAPP`, `EMAIL` e `SMS` ficam de fora: o que se aceita ali é o mesmo
 * termo de uso, e é a `TERMS` que eles referenciam.
 */
export const TermKindSchema = z.enum(['TERMS', 'SERVICE_LIABILITY', 'IMAGE_USE'])
export type TermKind = z.infer<typeof TermKindSchema>

/** Os três, em ordem de leitura na tela. Quem itera termo, itera por aqui. */
export const TERM_KINDS = [
  'TERMS',
  'SERVICE_LIABILITY',
  'IMAGE_USE',
] as const satisfies readonly TermKind[]

export const TERM_KIND_LABELS: Record<TermKind, string> = {
  TERMS: 'Termos de uso e privacidade',
  SERVICE_LIABILITY: 'Termo de responsabilidade',
  IMAGE_USE: 'Autorização de uso de imagem',
}

/**
 * O tipo de documento que o aceite arquiva.
 *
 * `TERMS` não aparece: o termo de uso é aceito no cadastro, com um visto, e o que
 * faltava era o texto — não um papel. Emitir PDF a cada cadastro produziria um arquivo
 * por tutor que ninguém pede e que a guarda de cinco anos teria de manter.
 */
export const TERM_DOCUMENT_KINDS: Partial<Record<TermKind, DocumentKind>> = {
  SERVICE_LIABILITY: 'TERM_ACCEPTANCE',
  IMAGE_USE: 'IMAGE_CONSENT',
}

/** O canal de `tutor_consents` em que o aceite deste termo é registrado. */
export function consentChannelForTerm(kind: TermKind): ConsentChannel {
  return kind
}

/**
 * A versão de qual termo este canal referencia.
 *
 * Os canais de comunicação apontam para `TERMS` porque é o termo de uso que descreve o
 * tratamento do contato — e é a versão dele que eles já gravavam desde o MOD-TUTOR.
 */
export function termKindForChannel(channel: ConsentChannel): TermKind {
  return channel === 'SERVICE_LIABILITY' || channel === 'IMAGE_USE' ? channel : 'TERMS'
}

/**
 * A versão que a plataforma semeia no provisionamento.
 *
 * É o mesmo número que `CURRENT_TERMS_VERSION` gravou em todo consentimento desde o
 * MOD-TUTOR, e é de propósito: sem ele, o primeiro aceite validado contra
 * `term_versions` invalidaria o parque inteiro de uma vez.
 */
export const DEFAULT_TERM_VERSION = '1.0'

/** `1`, `1.0`, `2.1.3`. Versão de termo é ordinal, não texto livre. */
export const TERM_VERSION_PATTERN = /^\d{1,3}(\.\d{1,3}){0,2}$/

export const TermVersionNumberSchema = z
  .string()
  .trim()
  .max(20)
  .regex(TERM_VERSION_PATTERN, 'Use números separados por ponto: 1.0, 2.0, 2.1')

// ─── Markdown restrito ───────────────────────────────────────────────────────

/**
 * O texto do termo é **Markdown restrito**, e restrito quer dizer quatro construções:
 * título, parágrafo, lista e negrito.
 *
 * O parser devolve blocos, e não HTML, porque o mesmo texto é desenhado em dois lugares
 * — o PDF do aceite e a tela que o apresenta ao tutor. Devolver HTML obrigaria a tela a
 * usar `dangerouslySetInnerHTML` sobre um texto que o tenant digitou, que é exatamente
 * a porta que este formato existe para fechar. Cada renderizador escapa do seu jeito.
 */
export interface TermSpan {
  text: string
  bold: boolean
}

export type TermBlock =
  | { type: 'heading'; spans: TermSpan[] }
  | { type: 'paragraph'; spans: TermSpan[] }
  | { type: 'list'; items: TermSpan[][] }

/** `**assim**` vira negrito. O resto do texto passa inteiro, inclusive `<` e `&`. */
function parseSpans(line: string): TermSpan[] {
  const spans: TermSpan[] = []
  for (const part of line.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue
    const bold = part.startsWith('**') && part.endsWith('**') && part.length > 4
    spans.push({ text: bold ? part.slice(2, -2) : part, bold })
  }
  return spans
}

export function parseTermBody(body: string): TermBlock[] {
  const blocks: TermBlock[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', spans: parseSpans(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = () => {
    if (list.length === 0) return
    blocks.push({ type: 'list', items: list.map(parseSpans) })
    list = []
  }

  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()

    if (line === '') {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^#{1,3}\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', spans: parseSpans(heading[1] ?? '') })
      continue
    }

    const item = /^[-*]\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      list.push(item[1] ?? '')
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}

// ─── Contratos de API ────────────────────────────────────────────────────────

/**
 * Publicar uma versão. **Não há rascunho e não há edição**: publicado é publicado.
 *
 * Editar o texto que alguém aceitou é falsificar o contrato de todo mundo que aceitou,
 * e é o que o AC-04 de MOD-DOC-06 proíbe — republicar a mesma versão devolve 409
 * `ERR_DOC_004`, com a orientação de subir o número.
 */
export const PublishTermVersionSchema = z.strictObject({
  kind: TermKindSchema,
  version: TermVersionNumberSchema,
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(50).max(40_000),
})
export type PublishTermVersionInput = z.output<typeof PublishTermVersionSchema>

export const TermVersionViewSchema = z.object({
  id: z.uuid(),
  kind: TermKindSchema,
  version: z.string(),
  title: z.string(),
  body: z.string(),
  /** Verdadeiro na versão mais recente de cada tipo — é ela que um aceite novo cita. */
  current: z.boolean(),
  /** Quantos aceites citam esta versão. É o que explica por que ela não se edita. */
  acceptances: z.number().int(),
  publishedAt: z.iso.datetime(),
  publishedBy: z.uuid().nullable(),
})
export type TermVersionView = z.infer<typeof TermVersionViewSchema>

export const TermVersionsResponseSchema = z.object({
  versions: z.array(TermVersionViewSchema),
})
export type TermVersionsResponse = z.infer<typeof TermVersionsResponseSchema>

/**
 * Registrar o aceite.
 *
 * A versão é opcional e o padrão é a vigente: quem apresenta o termo na tela apresenta
 * o texto de hoje. Mandá-la explicitamente serve para o cliente provar que exibiu
 * aquele texto, e uma versão que não é a vigente é recusada com 422 — aceite de texto
 * antigo é prova de outra coisa.
 */
export const AcceptTermSchema = z.strictObject({
  kind: TermKindSchema,
  version: TermVersionNumberSchema.optional(),
  /**
   * De onde veio o aceite, e é **prova**: o balcão e o Portal registram a mesma
   * autorização em circunstâncias diferentes.
   *
   * Quem o fixa é a porta do Portal (`tutor-port.ts`), como já fixa o `purpose` do
   * consentimento — o cliente não o escolhe, e a tela do Admin nem o envia.
   */
  source: z.enum(['STAFF_FORM', 'PORTAL']).default('STAFF_FORM'),
})
export type AcceptTermInput = z.output<typeof AcceptTermSchema>

export const TermAcceptanceViewSchema = z.object({
  consentId: z.uuid(),
  kind: TermKindSchema,
  version: z.string(),
  acceptedAt: z.iso.datetime(),
  /** Nulo no aceite de `TERMS`, que não arquiva papel. */
  documentId: z.uuid().nullable(),
  documentNumber: z.string().nullable(),
  documentStatus: z.enum(['PENDING', 'ISSUED', 'FAILED', 'CANCELLED']).nullable(),
})
export type TermAcceptanceView = z.infer<typeof TermAcceptanceViewSchema>

// ─── O texto padrão da plataforma ────────────────────────────────────────────

/**
 * O que todo tenant recebe no provisionamento, na versão `1.0`.
 *
 * É um piso, não um conselho jurídico: o petshop que tiver advogado publica o próprio
 * texto e a versão sobe. O que não pode existir é o caso de hoje — aceite registrado
 * sem texto nenhum por trás.
 *
 * O cabeçalho do documento já traz razão social, endereço, telefone e CNPJ do
 * estabelecimento (MOD-DOC-01), então o corpo fala em "o estabelecimento" e não repete
 * o que a folha já diz.
 */
export const PLATFORM_TERM_SEEDS: Record<TermKind, { title: string; body: string }> = {
  TERMS: {
    title: 'Termos de uso e política de privacidade',
    body: [
      '## Objeto',
      '',
      'Este termo rege a relação entre o tutor e o estabelecimento quanto ao cadastro,',
      'ao agendamento e à prestação de serviços de banho, tosa, atendimento veterinário',
      'e transporte, quando contratados.',
      '',
      '## Dados pessoais',
      '',
      'O estabelecimento trata os dados do tutor e do animal para **executar o contrato**',
      'de prestação de serviços, cumprir obrigações legais e manter o histórico clínico do',
      'animal, nos termos da Lei 13.709/2018 (LGPD).',
      '',
      '- Dados de contato são usados para confirmação, lembrete e aviso de serviço;',
      '- comunicação de marketing depende de autorização específica, revogável a qualquer momento;',
      '- o histórico clínico é guardado pelo prazo exigido pela legislação sanitária e veterinária.',
      '',
      '## Direitos do titular',
      '',
      'O tutor pode, a qualquer tempo, confirmar a existência de tratamento, acessar,',
      'corrigir e solicitar a exclusão de seus dados, bem como revogar consentimentos,',
      'pelo portal do cliente ou diretamente no balcão.',
      '',
      '## Vigência',
      '',
      'Este termo vale enquanto durar a relação entre as partes. Uma versão nova não',
      'apaga a anterior: o aceite registrado continua provando o texto que valia no dia.',
    ].join('\n'),
  },
  SERVICE_LIABILITY: {
    title: 'Termo de responsabilidade e ciência de riscos',
    body: [
      '## Declaração do tutor',
      '',
      'O tutor declara ser o responsável pelo animal identificado nesta folha e prestar',
      'informações **verdadeiras e completas** sobre a saúde, o comportamento e o histórico',
      'dele, incluindo alergias, doenças, medicações em uso e episódios de agressividade.',
      '',
      '## Riscos inerentes',
      '',
      'O tutor está ciente de que os serviços de banho, tosa, higiene e transporte envolvem',
      'contenção física do animal e de que há riscos que não decorrem de falha do',
      'estabelecimento, entre eles:',
      '',
      '- reação de estresse, vômito, diarreia ou vocalização durante o procedimento;',
      '- pequenos cortes e irritação de pele, sobretudo em animais com nós, pelo emaranhado ou pele sensível;',
      '- agravamento de condição de saúde preexistente não informada;',
      '- em animais idosos, braquicefálicos ou cardiopatas, risco aumentado durante a contenção e a secagem.',
      '',
      '## Conduta em emergência',
      '',
      'Havendo intercorrência, o estabelecimento tentará contato imediato com o tutor. Não',
      'sendo possível localizá-lo, fica **autorizado a tomar as providências veterinárias',
      'de urgência** necessárias à preservação da vida do animal, correndo por conta do',
      'tutor as despesas daí decorrentes.',
      '',
      '## Tosa e resultado estético',
      '',
      'O tutor está ciente de que o estado do pelo pode inviabilizar o corte pretendido e',
      'de que, em caso de nós severos, a tosa higiênica ou a raspagem pode ser o único',
      'procedimento seguro para o animal.',
      '',
      '## Retirada',
      '',
      'O animal deve ser retirado no horário combinado. A permanência além do horário de',
      'funcionamento, quando aceita pelo estabelecimento, pode ser cobrada como diária.',
    ].join('\n'),
  },
  IMAGE_USE: {
    title: 'Autorização de uso de imagem do animal',
    body: [
      '## Autorização',
      '',
      'O tutor autoriza, a título **gratuito** e por prazo indeterminado, o uso da imagem',
      'do animal identificado nesta folha, captada nas dependências do estabelecimento ou',
      'durante a prestação dos serviços.',
      '',
      '## Onde a imagem pode aparecer',
      '',
      '- redes sociais do estabelecimento;',
      '- site e portal do estabelecimento;',
      '- material impresso de divulgação, como cartazes, folhetos e cardápios de serviço.',
      '',
      '## Limites',
      '',
      'A autorização alcança a imagem do **animal**, e não a do tutor ou de sua família.',
      'Não abrange venda da imagem a terceiros, cessão a bancos de imagem nem uso que',
      'associe o animal a conteúdo ofensivo, político ou que exponha o tutor.',
      '',
      '## Revogação',
      '',
      'A autorização pode ser revogada a qualquer momento, pelo portal do cliente ou no',
      'balcão. A revogação vale para publicações futuras; o material já impresso ou',
      'publicado será retirado de circulação na medida do possível.',
    ].join('\n'),
  },
}
