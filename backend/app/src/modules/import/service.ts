import { createHash } from 'node:crypto'
import {
  AppError,
  CreateProfessionalSchema,
  CreateTutorSchema,
  IMPORT_ENTITIES,
  IMPORT_ENTITY_LABELS,
  IMPORT_MAX_REPORT_ROWS,
  IMPORT_MAX_ROWS,
  ImportPetSchema,
  UpdatePetSchema,
  UpdateProfessionalSchema,
  zonedMidnight,
  type ImportBatch,
  type ImportEntity,
  type ImportEntityInfo,
  type ImportOnExisting,
  type ImportOutcome,
  type ImportReport,
  type ImportReportRow,
  type ImportRequestInput,
  type ImportUndoResult,
  type Breed,
  type Size,
  type Species,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import type { ActorContext } from './actor.js'
import { normalize } from './coerce.js'
import { InvalidCsvError, parseCsv } from './csv.js'
import { invalid, notFound, notUndoable } from './errors.js'
import {
  CATALOG,
  ENTITY_DESCRIPTIONS,
  missingRequired,
  readRow,
  suggestMapping,
  templateCsv,
  type RowValues,
} from './mapping.js'
import { getPetPort, type PetCatalog } from './pet-port.js'
import * as repo from './repository.js'
import { getSchedulingPort } from './scheduling-port.js'
import { getTutorPort } from './tutor-port.js'

/**
 * MOD-IMPORT — a carga da base do sistema anterior.
 *
 * Módulo que **compõe**: fala com MOD-TUTOR, MOD-PET e MOD-AGENDA pelas três portas ao
 * lado, e nenhum deles fala com ele. Nenhuma escrita de domínio mora aqui — o tutor
 * importado nasce pelo mesmo `createTutor` do formulário, com a mesma cifragem, o mesmo
 * evento e a mesma trilha.
 *
 * Quatro decisões carregam o módulo:
 *
 * 1. **Analisar e aplicar são o MESMO código**, com um `commit` no fim. Um ensaio que
 *    rodasse validações diferentes das do gravar seria uma promessa falsa: o operador
 *    confere quatrocentas linhas verdes e o "aplicar" recusa quarenta.
 *
 * 2. **A idempotência é a chave NATURAL**, não uma tabela de correspondência: o
 *    CPF/CNPJ (ou o celular) do tutor, o par tutor+nome do pet, o nome do profissional,
 *    o trio pet+profissional+horário do agendamento. É a mesma chave que liga os
 *    arquivos entre si — o CSV de pets aponta o dono pelo CPF, como toda exportação de
 *    sistema antigo vem. Uma terceira tabela de `external_ref` daria um segundo
 *    conceito de identidade para as mesmas linhas.
 *
 * 3. **Uma transação por LINHA**, não por lote — consequência de compor os serviços,
 *    cada um com o seu `withTenant`. Falha na linha 300 deixa 299 criadas, e a tela diz
 *    isso: reenviar o arquivo corrigido converge, porque as 299 viram `IGNORADO`. "Tudo
 *    ou nada" exigiria o caminho de escrita paralelo que a decisão 1 recusa.
 *
 * 4. **Histórico não entra.** Só o que ainda vai acontecer. Agendamento passado
 *    importado seria varrido pelo `no-show-sweeper` na hora seguinte e viraria falta —
 *    com taxa, com mensagem e com um indicador de no-show que o petshop não viveu. E
 *    não haveria atendimento nem lançamento por trás dele: a agenda contaria uma
 *    história que o caixa desmente. O histórico fica no sistema antigo, que o petshop
 *    mantém em leitura.
 */

/* ═══════════════════════════════════════════════════ Catálogo (tela) */

/**
 * O catálogo que a tela usa para montar o mapeamento **e** o modelo CSV. Uma fonte só:
 * um modelo escrito à mão no frontend divergiria do que o backend aceita no primeiro
 * campo novo.
 */
export function entities(): ImportEntityInfo[] {
  return IMPORT_ENTITIES.map((entity) => ({
    entity,
    label: IMPORT_ENTITY_LABELS[entity],
    description: ENTITY_DESCRIPTIONS[entity],
    fields: CATALOG[entity].map((spec) => ({
      field: spec.field,
      label: spec.label,
      required: Boolean(spec.required),
      example: spec.example,
      hint: spec.hint ?? null,
    })),
    template: templateCsv(entity),
  }))
}

/* ═══════════════════════════════════════════════════ Análise e carga */

export function analyze(actor: ActorContext, request: ImportRequestInput): Promise<ImportReport> {
  return run(actor, request, false)
}

export function apply(actor: ActorContext, request: ImportRequestInput): Promise<ImportReport> {
  return run(actor, request, true)
}

async function run(
  actor: ActorContext,
  request: ImportRequestInput,
  commit: boolean,
): Promise<ImportReport> {
  const bytes = decodeUpload(request.content)
  const fileHash = createHash('sha256').update(bytes).digest('hex')

  let parsed
  try {
    parsed = parseCsv(bytes)
  } catch (error) {
    if (error instanceof InvalidCsvError) throw invalid(error.message)
    throw error
  }

  if (parsed.rows.length > IMPORT_MAX_ROWS) {
    throw invalid(
      `O arquivo tem ${parsed.rows.length} linhas e o limite por carga é ${IMPORT_MAX_ROWS}. ` +
        'Divida a planilha — as cargas são idempotentes, então subir em partes não duplica nada.',
    )
  }

  const mapping = request.mapping ?? suggestMapping(request.entity, parsed.headers)
  const missing = missingRequired(request.entity, mapping)
  const previousBatch = await repo.findAppliedByHash(actor.tenantId, fileHash)

  const report: ImportReport = {
    entity: request.entity,
    fileName: request.fileName,
    fileHash,
    delimiter: parsed.delimiter,
    encoding: parsed.encoding,
    headers: parsed.headers,
    mapping,
    missing,
    rowCount: parsed.rows.length,
    counts: { created: 0, updated: 0, ignored: 0, failed: 0 },
    rows: [],
    truncated: false,
    previousBatch,
  }

  /**
   * Sem um obrigatório mapeado, nem a análise roda: o relatório seria uma parede de
   * "Nome do pet é obrigatório" repetida quatrocentas vezes, escondendo o fato de que o
   * problema é UM — uma coluna que ninguém apontou.
   */
  if (missing.length > 0) return report

  const context = await newContext(actor, request.entity, commit)
  const all: ImportReportRow[] = []

  for (let index = 0; index < parsed.rows.length; index += 1) {
    // O cabeçalho é a linha 1 no Excel: é assim que o operador acha a linha.
    const lineNo = index + 2
    const values = readRow(request.entity, mapping, parsed.rows[index] as string[])
    const ref = refOf(request.entity, values)

    if (values.errors.length > 0) {
      all.push({ lineNo, ref, outcome: 'ERRO', message: values.errors.join(' · '), entityId: null })
      continue
    }

    try {
      const result = await HANDLERS[request.entity](context, values, request.onExisting)
      all.push({
        lineNo,
        ref,
        outcome: result.outcome,
        message: result.message ?? null,
        entityId: result.entityId ?? null,
      })
    } catch (error) {
      all.push({ lineNo, ref, outcome: 'ERRO', message: messageOf(error), entityId: null })
    }
  }

  for (const row of all) {
    if (row.outcome === 'CRIADO') report.counts.created += 1
    else if (row.outcome === 'ATUALIZADO') report.counts.updated += 1
    else if (row.outcome === 'IGNORADO') report.counts.ignored += 1
    else report.counts.failed += 1
  }

  if (commit) {
    report.batchId = await repo.insertBatch(actor.tenantId, {
      entity: request.entity,
      fileName: request.fileName,
      fileHash,
      mapping,
      rowCount: parsed.rows.length,
      created: report.counts.created,
      updated: report.counts.updated,
      ignored: report.counts.ignored,
      failed: report.counts.failed,
      createdBy: actor.actorUserId ?? null,
      rows: all,
    })
  }

  // Erros voltam TODOS (são o que se conserta); o resto é amostra + contagem.
  const failed = all.filter((row) => row.outcome === 'ERRO')
  const ok = all.filter((row) => row.outcome !== 'ERRO')
  report.rows = [...failed, ...ok.slice(0, IMPORT_MAX_REPORT_ROWS)].sort(
    (left, right) => left.lineNo - right.lineNo,
  )
  report.truncated = ok.length > IMPORT_MAX_REPORT_ROWS

  return report
}

/**
 * Data URL base64 → bytes.
 *
 * Devolve BYTES, não texto: quem decide a codificação é o `csv.ts`, olhando o conteúdo.
 * Decodificar aqui como UTF-8 destruiria os acentos de todo arquivo salvo pelo Excel em
 * pt-BR antes de alguém poder detectá-los.
 */
function decodeUpload(raw: string): Buffer {
  const match = /^data:[^;]*;base64,(.+)$/s.exec(raw)
  const buffer = Buffer.from(match ? (match[1] as string) : raw, 'base64')
  if (buffer.length === 0) throw invalid('O arquivo chegou vazio.')
  return buffer
}

/**
 * A mensagem que vai para a linha do relatório.
 *
 * O erro de domínio atravessa com o texto do módulo dono — "Ana Paula não executa
 * Banho", "Já existe pet com este microchip". Reescrevê-lo aqui trocaria a frase de
 * quem conhece a regra pela de quem só sabe que deu errado.
 */
function messageOf(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof ZodLikeError) return error.message
  logger.warn({ err: error }, 'linha da importação falhou por erro inesperado')
  return error instanceof Error ? error.message : 'Erro inesperado'
}

/** Um `ZodError` já formatado — ver `parseOrThrow`. */
class ZodLikeError extends Error {}

interface ZodIssue {
  path: (string | number)[]
  message: string
}

/**
 * Roda o schema do MÓDULO DONO e devolve a mensagem no formato do relatório.
 *
 * É o que faz a importação recusar exatamente o que o formulário recusaria — dígito de
 * CPF, DDD inexistente, PJ sem razão social — sem uma segunda cópia de nenhuma regra.
 */
function parseOrThrow<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: unknown,
): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data as T

  const issues = ((result.error as { issues?: ZodIssue[] } | undefined)?.issues ?? []) as ZodIssue[]
  throw new ZodLikeError(
    issues.length === 0
      ? 'Dados inválidos'
      : issues.map((issue) => `${issue.path.join('.') || 'campo'}: ${issue.message}`).join(' · '),
  )
}

/** A chave natural da linha — é o que o relatório mostra para achá-la na planilha. */
function refOf(entity: ImportEntity, values: RowValues): string | null {
  if (entity === 'TUTOR') {
    return (
      str(values.payload.cpf) ??
      str(values.payload.cnpj) ??
      str(values.payload.phone) ??
      str(values.payload.fullName)
    )
  }
  if (entity === 'PET')
    return `${str(values.refs.tutorRef) ?? '?'}/${str(values.payload.name) ?? '?'}`
  if (entity === 'PROFISSIONAL') return str(values.payload.displayName)
  return `${str(values.refs.petName) ?? '?'} ${str(values.refs.date) ?? ''} ${str(values.refs.time) ?? ''}`.trim()
}

function str(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

/* ═══════════════════════════════════════════════════ Contexto do lote */

/**
 * O que vale para o arquivo inteiro, carregado UMA vez.
 *
 * Sem isto, resolver "Golden Retriever" custaria uma consulta por linha — quatrocentas
 * viagens ao banco para responder a mesma pergunta. Só o que é lookup pequeno e estável
 * entra aqui; tutor e pet continuam sendo resolvidos linha a linha, porque o próprio
 * arquivo os cria enquanto roda.
 */
interface Context {
  actor: ActorContext
  commit: boolean
  now: Date
  /** O fuso do estabelecimento. A planilha traz hora de parede; o banco guarda instante. */
  timezone: string
  catalog: PetCatalog | null
  /** nome normalizado → profissional. Cresce durante a carga. */
  professionals: Map<string, { id: string; displayName: string }>
  /** nome normalizado → serviço. */
  services: Map<string, { id: string; name: string }>
}

async function newContext(
  actor: ActorContext,
  entity: ImportEntity,
  commit: boolean,
): Promise<Context> {
  const context: Context = {
    actor,
    commit,
    now: new Date(),
    timezone: 'UTC',
    catalog: null,
    professionals: new Map(),
    services: new Map(),
  }

  if (entity === 'PET') {
    context.catalog = await getPetPort().loadCatalog(actor.tenantId)
  }

  if (entity === 'PROFISSIONAL' || entity === 'AGENDA') {
    const scheduling = getSchedulingPort()
    for (const service of await scheduling.listServices(actor)) {
      context.services.set(normalize(service.name), { id: service.id, name: service.name })
    }
    for (const professional of await scheduling.listProfessionals(actor)) {
      context.professionals.set(normalize(professional.displayName), {
        id: professional.id,
        displayName: professional.displayName,
      })
    }
  }

  if (entity === 'AGENDA') {
    context.timezone = await getSchedulingPort().timezone(actor.tenantId)
  }

  return context
}

/* ═══════════════════════════════════════════════════ Handlers */

interface RowResult {
  outcome: ImportOutcome
  entityId?: string | null
  message?: string
}

type Handler = (
  context: Context,
  values: RowValues,
  onExisting: ImportOnExisting,
) => Promise<RowResult>

/* ── Tutores ────────────────────────────────────────────────────── */

const importTutor: Handler = async (context, values, onExisting) => {
  const port = getTutorPort()

  const address = completeAddress(values.address)

  const input = parseOrThrow(CreateTutorSchema, {
    ...values.payload,
    ...(address ? { address } : {}),
    consents: {
      /**
       * O aceite de termo entra como `true` com origem `IMPORT`.
       *
       * Não é uma caixa marcada por nós: é o registro de que a relação já existia no
       * sistema anterior, e a origem `IMPORT` é o que diz a quem ler a trilha que a
       * prova é de segunda mão. O contrário — recusar toda a base por falta de um
       * aceite feito aqui — obrigaria o petshop a recoletar a assinatura de
       * quatrocentos clientes antes de poder atendê-los.
       */
      terms: true,
      /**
       * Marketing é o oposto: **nasce NÃO** e só uma coluna dizendo sim o liga.
       * Presumir consentimento de promoção é exatamente o que a LGPD guarda com mais
       * força, e o que faria a estreia do sistema ser uma leva de mensagens que
       * ninguém pediu. O lembrete do banho continua saindo — ele é transacional.
       */
      whatsapp: values.consent.whatsapp ?? false,
      email: values.consent.email ?? false,
      imageUse: values.consent.imageUse ?? false,
    },
    /**
     * A duplicata **provável** é reconhecida de saída, e isso é deliberado.
     *
     * A chave exata (CPF, CNPJ, celular) já foi conferida logo abaixo: se batesse, a
     * linha seria `IGNORADO` e não chegaria aqui. O que sobra é a semelhança de nome —
     * e num petshop com quatrocentos clientes há duas "Maria Silva" que são duas
     * pessoas. Bloquear por isso tornaria a carga impossível justamente nas bases
     * grandes, sem oferecer ao operador nenhuma forma de dizer "sim, são duas".
     *
     * O que fica no lugar do bloqueio é a prova: `createTutor` grava
     * `tutor.duplicate_override` na trilha a cada linha, e a unificação de fichas
     * (MOD-TUTOR-07) é a ferramenta de quem encontrar duas depois.
     */
    duplicateAcknowledged: true,
  })

  const ref = (input.cpf ?? input.cnpj ?? input.phone) as string
  const existing = await port.findByRef(context.actor.tenantId, ref)

  if (existing) {
    if (onExisting === 'IGNORAR') {
      return {
        outcome: 'IGNORADO',
        entityId: existing.id,
        message: `Já cadastrado como ${existing.fullName}`,
      }
    }
    if (context.commit) {
      /**
       * O PATCH parte do que foi **mapeado**, e não do input completo.
       *
       * O schema de criação aplica padrões (`status: ACTIVE`, tipo de pessoa, o bloco
       * de consentimento inteiro); reaproveitá-lo no `ATUALIZAR` mandaria esses valores
       * para dentro de um cadastro que a planilha nem menciona — um cliente inativado à
       * mão voltaria a ativo, e o consentimento de marketing que ele revogou seria
       * reescrito por uma coluna que o arquivo não tinha.
       */
      await port.update(context.actor, existing.id, values.payload)
    }
    return { outcome: 'ATUALIZADO', entityId: existing.id }
  }

  if (!context.commit) {
    return {
      outcome: 'CRIADO',
      ...(address === null && values.address !== null
        ? { message: 'Endereço incompleto — o cadastro entra sem ele' }
        : {}),
    }
  }

  const created = await port.create(context.actor, input)
  return {
    outcome: 'CRIADO',
    entityId: created.id,
    ...(address === null && values.address !== null
      ? { message: 'Endereço incompleto — o cadastro entrou sem ele' }
      : {}),
  }
}

/**
 * O endereço só entra **completo**.
 *
 * `AddressInputSchema` exige CEP, logradouro, número, bairro, cidade e UF, e é uma
 * exigência com razão: endereço pela metade não roteiriza o leva-e-traz e não imprime
 * num documento. A planilha que traz só a rua faria a linha inteira falhar por um campo
 * acessório — então o endereço torto é descartado, o cadastro entra, e o relatório diz
 * que ele entrou sem endereço.
 */
function completeAddress(address: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!address) return null
  const required = ['zipCode', 'street', 'number', 'district', 'city', 'state']
  return required.every((field) => address[field] !== undefined) ? address : null
}

/* ── Pets ───────────────────────────────────────────────────────── */

const importPet: Handler = async (context, values, onExisting) => {
  const petPort = getPetPort()
  const catalog = context.catalog as PetCatalog

  const tutorRef = values.refs.tutorRef as string
  const tutor = await getTutorPort().findByRef(context.actor.tenantId, tutorRef)
  if (!tutor) {
    throw invalid(
      `Tutor ${tutorRef} não encontrado — importe os tutores antes, e use o mesmo CPF ou celular que está lá`,
    )
  }

  const species = pickByLabel(catalog.species, values.refs.species as string)
  if (!species) {
    throw invalid(
      `Espécie "${values.refs.species as string}" não existe no catálogo (aceitas: ${labelsOf(catalog.species)})`,
    )
  }

  const breed = await resolveBreed(context, species, values.refs.breed as string | undefined)
  const size = resolveSize(catalog, values.refs.size as string | undefined, breed)
  if (!size) {
    throw invalid(
      values.refs.size
        ? `Porte "${values.refs.size as string}" não existe no catálogo (aceitos: ${labelsOf(catalog.sizes)})`
        : `Porte não informado e a raça não tem porte padrão — o porte decide o preço e a duração do banho`,
    )
  }

  const coat = values.refs.coat ? pickByLabel(catalog.coats, values.refs.coat as string) : null
  if (values.refs.coat && !coat) {
    throw invalid(
      `Pelagem "${values.refs.coat as string}" não existe no catálogo (aceitas: ${labelsOf(catalog.coats)})`,
    )
  }

  const payload = {
    ...values.payload,
    speciesId: species.id,
    sizeId: size.id,
    ...(breed ? { breedId: breed.id } : {}),
    ...(coat ? { coatId: coat.id } : {}),
  }

  const name = values.payload.name as string
  const siblings = await petPort.listByTutor(context.actor.tenantId, tutor.id)
  const existing = siblings.find((pet) => normalize(pet.name) === normalize(name))

  if (existing) {
    if (onExisting === 'IGNORAR') {
      return {
        outcome: 'IGNORADO',
        entityId: existing.id,
        message: `${tutor.fullName} já tem um pet chamado ${existing.name}`,
      }
    }
    if (context.commit)
      await petPort.update(context.actor, existing.id, parseOrThrow(UpdatePetSchema, payload))
    return { outcome: 'ATUALIZADO', entityId: existing.id }
  }

  /**
   * O schema roda **antes** do `commit`, e o mesmo nos dois caminhos.
   *
   * É a decisão 1 do módulo em uma linha: o que a análise aprova é exatamente o que o
   * aplicar grava. Na análise a raça nova ainda não existe e o `breedId` não vai junto —
   * o que falta ali é um id que a carga vai criar, e não um dado que alguém precise
   * corrigir na planilha.
   */
  const input = parseOrThrow(ImportPetSchema, {
    ...payload,
    // O primeiro responsável é sempre o principal: é dele que saem a cobrança, a
    // autorização de procedimento e o acesso ao Portal. Um pet sem principal não pode
    // ser agendado (o MOD-AGENDA recusa), e a planilha traz um dono por linha.
    tutors: [{ tutorId: tutor.id, role: 'PRIMARY', canAuthorizeProcedures: true }],
  })

  if (!context.commit) return { outcome: 'CRIADO' }

  const created = await petPort.create(context.actor, input)
  return { outcome: 'CRIADO', entityId: created.id }
}

/**
 * A raça, criada quando não existe.
 *
 * Deliberado: a lista de raças é o vocabulário da clientela, não nosso. Recusar a linha
 * por uma raça não cadastrada obrigaria o operador a adivinhar a lista inteira antes de
 * importar — e a saída fácil seria deixar a coluna de fora, perdendo o dado.
 *
 * Na análise nada é criado, e a função devolve `null`: o relatório não promete um id
 * que ainda não existe.
 */
async function resolveBreed(
  context: Context,
  species: Species,
  label: string | undefined,
): Promise<Breed | null> {
  if (!label) return null

  const catalog = context.catalog as PetCatalog
  const known = catalog.breedsBySpecies.get(species.id) ?? []
  const found = known.find((breed) => normalize(breed.label) === normalize(label))
  if (found) return found

  if (!context.commit) return null

  const created = await getPetPort().createBreed(context.actor, species.id, label)
  catalog.breedsBySpecies.set(species.id, [...known, created])
  return created
}

/**
 * O porte: o da planilha, ou o padrão da raça.
 *
 * A queda para a raça não é conveniência — é o que o formulário faz quando a recepção
 * escolhe "Golden Retriever" e o campo de porte se preenche sozinho. Sem ela, toda
 * planilha sem coluna de porte falharia inteira, e o porte é o que decide preço e
 * duração do banho.
 */
function resolveSize(
  catalog: PetCatalog,
  label: string | undefined,
  breed: Breed | null,
): Size | null {
  if (label) return pickByLabel(catalog.sizes, label)
  if (!breed?.defaultSizeId) return null
  return catalog.sizes.find((size) => size.id === breed.defaultSizeId) ?? null
}

function pickByLabel<T extends { label: string; key?: string }>(
  items: T[],
  label: string,
): T | null {
  const wanted = normalize(label)
  return (
    items.find((item) => normalize(item.label) === wanted) ??
    items.find((item) => normalize(item.key ?? '') === wanted) ??
    null
  )
}

function labelsOf(items: { label: string }[]): string {
  return items.map((item) => item.label).join(', ')
}

/* ── Profissionais ──────────────────────────────────────────────── */

const importProfessional: Handler = async (context, values, onExisting) => {
  const scheduling = getSchedulingPort()

  const displayName = values.payload.displayName as string
  const serviceIds = resolveServices(context, values.refs.services as string[] | undefined)

  const existing = context.professionals.get(normalize(displayName))

  if (existing) {
    if (onExisting === 'IGNORAR') {
      return { outcome: 'IGNORADO', entityId: existing.id, message: 'Já cadastrado com este nome' }
    }
    if (context.commit) {
      await scheduling.updateProfessional(
        context.actor,
        existing.id,
        parseOrThrow(UpdateProfessionalSchema, {
          ...values.payload,
          ...(serviceIds ? { serviceIds } : {}),
        }),
      )
    }
    return { outcome: 'ATUALIZADO', entityId: existing.id }
  }

  // Mesmo schema nos dois caminhos, pela mesma razão do pet.
  const input = parseOrThrow(CreateProfessionalSchema, {
    ...values.payload,
    serviceIds: serviceIds ?? [],
  })

  if (!context.commit) {
    return {
      outcome: 'CRIADO',
      ...(serviceIds && serviceIds.length > 0
        ? {}
        : {
            message:
              'Sem serviço habilitado — ninguém consegue marcar com esta pessoa até você habilitar',
          }),
    }
  }

  const created = await scheduling.createProfessional(context.actor, input)
  context.professionals.set(normalize(created.displayName), {
    id: created.id,
    displayName: created.displayName,
  })

  return {
    outcome: 'CRIADO',
    entityId: created.id,
    ...(serviceIds && serviceIds.length > 0
      ? {}
      : {
          message:
            'Sem serviço habilitado — ninguém consegue marcar com esta pessoa até você habilitar',
        }),
  }
}

/**
 * Nomes de serviço → ids do catálogo.
 *
 * Serviço desconhecido **levanta**, e não é criado: ao contrário da raça, um serviço
 * carrega preço e duração por porte, e inventar um sem eles produziria um item que a
 * agenda recusa na primeira tentativa de marcar ("não tem preço definido para o porte")
 * — um cadastro que existe e não serve para nada.
 */
function resolveServices(context: Context, names: string[] | undefined): string[] | undefined {
  if (!names) return undefined

  return names.map((name) => {
    const found = context.services.get(normalize(name))
    if (!found) {
      throw invalid(
        `Serviço "${name}" não existe no catálogo (cadastrados: ${[...context.services.values()]
          .map((service) => service.name)
          .join(', ')})`,
      )
    }
    return found.id
  })
}

/* ── Agendamentos ───────────────────────────────────────────────── */

const importAppointment: Handler = async (context, values) => {
  const scheduling = getSchedulingPort()

  const tutorRef = values.refs.tutorRef as string
  const tutor = await getTutorPort().findByRef(context.actor.tenantId, tutorRef)
  if (!tutor) throw invalid(`Tutor ${tutorRef} não encontrado — importe os tutores antes`)

  const petName = values.refs.petName as string
  const pets = await getPetPort().listByTutor(context.actor.tenantId, tutor.id)
  const pet = pets.find((one) => normalize(one.name) === normalize(petName))
  if (!pet) {
    throw invalid(`${tutor.fullName} não tem pet chamado "${petName}" — importe os pets antes`)
  }

  const professionalName = values.refs.professional as string
  const professional = context.professionals.get(normalize(professionalName))
  if (!professional) {
    throw invalid(
      `Profissional "${professionalName}" não encontrado — importe os profissionais antes`,
    )
  }

  const serviceIds = resolveServices(context, values.refs.services as string[]) as string[]

  const startsAt = instantOf(
    values.refs.date as string,
    values.refs.time as string,
    context.timezone,
  )

  /**
   * O que já passou não entra.
   *
   * Um agendamento passado gravado como CONFIRMED é varrido pelo `no-show-sweeper` na
   * hora seguinte e vira falta — com taxa, com mensagem ao tutor e com um indicador de
   * no-show que o petshop nunca viveu. E não haveria atendimento nem lançamento por
   * trás dele: a agenda contaria uma história que o caixa desmente.
   */
  if (startsAt.getTime() <= context.now.getTime()) {
    return {
      outcome: 'IGNORADO',
      message:
        'Já passou — o histórico fica no sistema antigo, só o que ainda vai acontecer entra aqui',
    }
  }

  // Janela de um minuto: a chave é o instante exato, e o intervalo existe só porque o
  // filtro da consulta é por faixa.
  const existing = (
    await scheduling.listForPet(
      context.actor,
      pet.id,
      new Date(startsAt.getTime() - 60_000),
      new Date(startsAt.getTime() + 60_000),
    )
  ).find(
    (appointment) =>
      appointment.professionalId === professional.id &&
      new Date(appointment.startsAt).getTime() === startsAt.getTime() &&
      appointment.status !== 'CANCELLED',
  )

  /**
   * Agendamento que já existe é sempre `IGNORADO`, mesmo em ATUALIZAR.
   *
   * "Atualizar" um horário marcado seria remarcá-lo, e remarcar tem regra própria — a
   * cadeia de remarcação, o aviso ao tutor, a liberação do horário antigo. Uma carga
   * não faz isso de lado; quem remarca é a tela.
   */
  if (existing) {
    return { outcome: 'IGNORADO', entityId: existing.id, message: 'Este horário já está na agenda' }
  }

  if (!context.commit) {
    /**
     * A análise **não** simula a marcação.
     *
     * Jornada, capacidade e habilitação dependem do que as linhas anteriores do próprio
     * arquivo criaram, e conferi-las sem gravar diria "cabe" para dez pets no mesmo
     * horário de quem atende dois. O que se confere aqui é o que não depende de
     * concorrência: o pet existe, o profissional existe, os serviços existem, a data é
     * futura. O resto aparece no relatório do "aplicar", linha a linha.
     */
    return { outcome: 'CRIADO' }
  }

  const created = await scheduling.book(context.actor, {
    petId: pet.id,
    professionalId: professional.id,
    startsAt,
    serviceIds,
    notes: values.payload.notes as string | undefined,
  })

  return { outcome: 'CRIADO', entityId: created.id }
}

/**
 * Hora de parede do estabelecimento → instante UTC.
 *
 * A planilha diz "05/10/2026 14:30", e 14:30 é o que a recepção lê no relógio dela.
 * Montar `2026-10-05T14:30:00Z` deslocaria a agenda inteira em três horas — o banho das
 * 14:30 cairia às 11:30, dentro da jornada de outro turno, e ninguém notaria até o
 * primeiro cliente aparecer na hora errada.
 *
 * A conta é a mesma que a jornada do profissional usa (`zonedMidnight` + minutos), e
 * isso importa: é o que garante que o agendamento caia exatamente onde a jornada o
 * espera, inclusive na virada do horário de verão.
 */
function instantOf(dateISO: string, time: string, timezone: string): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  return new Date(zonedMidnight(dateISO, timezone).getTime() + (hour * 60 + minute) * 60_000)
}

const HANDLERS: Record<ImportEntity, Handler> = {
  TUTOR: importTutor,
  PET: importPet,
  PROFISSIONAL: importProfessional,
  AGENDA: importAppointment,
}

/* ═══════════════════════════════════════════════════ Histórico e desfazer */

export function listBatches(tenantId: string): Promise<ImportBatch[]> {
  return repo.listBatches(tenantId)
}

export async function getBatch(tenantId: string, batchId: string): Promise<ImportBatch> {
  const batch = await repo.findBatch(tenantId, batchId)
  if (!batch) throw notFound()
  return { ...batch, rows: await repo.listRows(tenantId, batchId) }
}

/**
 * Desfaz o lote.
 *
 * Desmonta **só o que ele CRIOU**, nunca o que atualizou: quem reimportou por cima de
 * um cadastro que já existia não quer que desfazer apague o cadastro.
 *
 * Cada passo desmonta do seu jeito, e a diferença não é detalhe de implementação:
 *
 * - **Tutor não é desfeito.** É a única entidade cuja sobra não é errada — a chave é o
 *   CPF (ou o celular), então reimportar o arquivo corrigido com ATUALIZAR converge por
 *   cima, que é um conserto melhor do que apagar e recriar. E apagá-lo de verdade
 *   alcançaria pet, agenda, extrato, mensagens e sessão do Portal: a exclusão de tutor
 *   tem tela, regra e trilha próprias (MOD-TUTOR-08), e abrir essa porta para servir ao
 *   desfazer de uma importação é caro demais pelo que se ganha.
 * - **Pet é apagado** — exclusão lógica, a mesma da tela. Só que **não** se ele já
 *   ganhou agenda: o pet sumiria e o horário ficaria marcado para um cadastro que não
 *   existe mais.
 * - **Profissional é desativado**, não apagado: o módulo não tem exclusão, e é
 *   deliberado — o nome de quem executou um atendimento precisa continuar legível no
 *   histórico. A desativação passa pela regra do próprio MOD-AGENDA, que recusa desligar
 *   quem tem agendamento futuro sem reatribuição.
 * - **Agendamento é cancelado**, sem taxa e em silêncio: a carga entrou calada, e
 *   avisar o cancelamento seria a primeira notícia que o cliente receberia do sistema
 *   novo sobre algo que, para ele, nunca existiu.
 *
 * A recusa é a metade que importa, e ela vem ANTES de desmontar qualquer coisa: metade
 * desfeito é pior que nada desfeito.
 */
export async function undo(actor: ActorContext, batchId: string): Promise<ImportUndoResult> {
  const batch = await repo.findBatch(actor.tenantId, batchId)
  if (!batch) throw notFound()
  if (batch.status === 'DESFEITO') throw notUndoable('Este lote já foi desfeito.')

  const created = await repo.listCreated(actor.tenantId, batchId)

  if (batch.entity === 'TUTOR') {
    await repo.markUndone(actor.tenantId, batchId)
    return { batchId, removed: 0, keptTutors: created.length }
  }

  if (batch.entity === 'PET') await assertPetsUndoable(actor, created)

  let removed = 0
  for (const row of created) {
    try {
      if (batch.entity === 'PET') await getPetPort().remove(actor, row.entityId)
      else if (batch.entity === 'PROFISSIONAL') {
        await getSchedulingPort().updateProfessional(actor, row.entityId, { active: false })
      } else await getSchedulingPort().cancelSilently(actor, row.entityId)
      removed += 1
    } catch (error) {
      throw notUndoable(
        `Não foi possível desfazer ${row.ref ?? row.entityId}: ${messageOf(error)}. ` +
          'Desfaça primeiro os lotes que dependem dele — agendamentos antes de pets, pets antes de tutores.',
      )
    }
  }

  await repo.markUndone(actor.tenantId, batchId)
  return { batchId, removed, keptTutors: 0 }
}

/**
 * O lote de pets pode ser desfeito inteiro?
 *
 * O que impede é o pet já ter agenda. `appointments.pet_id` é `ON DELETE RESTRICT`, mas
 * a exclusão do pet é **lógica** — o banco não reclamaria, e o horário ficaria marcado
 * para um cadastro apagado, aparecendo no painel do dia sem ficha por trás.
 */
async function assertPetsUndoable(
  actor: ActorContext,
  created: { entityId: string; ref: string | null }[],
): Promise<void> {
  const scheduling = getSchedulingPort()
  for (const row of created) {
    if (await scheduling.hasAppointments(actor, row.entityId)) {
      throw notUndoable(
        `O pet ${row.ref ?? row.entityId} já tem horário marcado — desfaça o lote de agendamentos primeiro. ` +
          'Apagar o pet deixaria a agenda apontando para um cadastro que não existe.',
      )
    }
  }
}
