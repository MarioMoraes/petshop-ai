import { z } from 'zod'

/**
 * MOD-IMPORT — o contrato da carga da base anterior.
 *
 * O petshop que troca de sistema não redigita quatrocentos tutores: ele sobe a
 * planilha que exportou do sistema antigo. Este arquivo é o que o backend, o cliente
 * de API e a tela dividem — a lista de passos, o formato do pedido e a forma do
 * relatório.
 */

/**
 * Os quatro passos, **na ordem de dependência**.
 *
 * Não é ordem de navegação: o pet aponta o tutor pelo CPF ou pelo telefone, e o
 * agendamento aponta o pet e o profissional pelo nome. Subir fora de ordem não corrompe
 * nada — a linha falha nomeando o que faltou ("Tutor 12345678909 não encontrado —
 * importe os tutores antes") —, mas subir na ordem é o que faz a carga funcionar de
 * primeira.
 */
export const IMPORT_ENTITIES = ['TUTOR', 'PET', 'PROFISSIONAL', 'AGENDA'] as const
export type ImportEntity = (typeof IMPORT_ENTITIES)[number]

export const ImportEntitySchema = z.enum(IMPORT_ENTITIES)

/** Rótulo de cada passo — é o que a tela numera. */
export const IMPORT_ENTITY_LABELS: Record<ImportEntity, string> = {
  TUTOR: 'Tutores',
  PET: 'Pets',
  PROFISSIONAL: 'Profissionais',
  AGENDA: 'Agendamentos futuros',
}

/**
 * Teto de linhas por arquivo.
 *
 * Não é limite de banco: é o tempo de uma requisição. Cada linha abre transação
 * própria (uma por linha, ver `import/service.ts`), e cinco mil já levam minutos. A
 * mensagem de recusa manda dividir a planilha — a carga é idempotente, então subir em
 * partes não duplica nada.
 */
export const IMPORT_MAX_ROWS = 5_000

/**
 * Quantas linhas do relatório voltam à tela.
 *
 * As linhas com ERRO voltam **todas**, sempre, independente deste teto: são elas que o
 * operador corrige, e cortá-las faria a segunda tentativa descobrir o que a primeira já
 * sabia. O teto vale para o que deu certo, que a tela resume por contagem.
 */
export const IMPORT_MAX_REPORT_ROWS = 200

/**
 * O que fazer quando a chave natural já existe neste estabelecimento.
 *
 * Nasce em `IGNORAR`: uma segunda passada do mesmo arquivo não deve reescrever cadastro
 * que alguém já corrigiu à mão depois da carga. `ATUALIZAR` é o caminho deliberado de
 * consertar um lote inteiro — reenviar o arquivo certo, com as mesmas chaves.
 */
export const ImportOnExistingSchema = z.enum(['IGNORAR', 'ATUALIZAR'])
export type ImportOnExisting = z.output<typeof ImportOnExistingSchema>

/**
 * Mapeamento confirmado pelo humano: `campo → índice da coluna`.
 *
 * Ausente, o serviço usa a sugestão do farejador. Isso é conveniência da primeira
 * análise, **não** um atalho para aplicar: a tela sempre manda o mapa que o operador
 * viu, e é ele que fica gravado no lote.
 */
const MappingSchema = z.record(z.string().max(60), z.number().int().min(0).max(500))

/**
 * O arquivo viaja como **data URL base64 no JSON**, sem multipart.
 *
 * O `@fastify/multipart` deste processo é registrado por escopo, com limites feitos
 * para foto de pet; e o CSV precisa chegar em **bytes**, porque quem decide a
 * codificação é o farejador olhando o conteúdo. Um CSV de 5.000 pets com 20 colunas tem
 * ~700 KB, e ~1 MB em base64.
 */
export const ImportRequestSchema = z.object({
  entity: ImportEntitySchema,
  fileName: z.string().trim().min(1).max(200),
  content: z
    .string()
    .min(1)
    .max(8 * 1024 * 1024),
  mapping: MappingSchema.optional(),
  onExisting: ImportOnExistingSchema.default('IGNORAR'),
})
export type ImportRequestInput = z.output<typeof ImportRequestSchema>

export const ImportOutcomeSchema = z.enum(['CRIADO', 'ATUALIZADO', 'IGNORADO', 'ERRO'])
export type ImportOutcome = z.output<typeof ImportOutcomeSchema>

export const ImportReportRowSchema = z.object({
  /** A linha como o operador a vê no Excel: o cabeçalho é a 1. */
  lineNo: z.number().int(),
  /** A chave natural (CPF, nome do pet, nome do profissional) — como achá-la lá. */
  ref: z.string().nullable(),
  outcome: ImportOutcomeSchema,
  message: z.string().nullable(),
  /**
   * O registro que a linha criou ou atualizou. Nulo na análise (nada foi gravado) e nas
   * linhas com erro. É o que permite ao desfazer saber o que apagar.
   */
  entityId: z.uuid().nullable(),
})
export type ImportReportRow = z.infer<typeof ImportReportRowSchema>

export const ImportReportSchema = z.object({
  entity: ImportEntitySchema,
  fileName: z.string(),
  fileHash: z.string(),
  /** Como o arquivo foi lido. O farejador decidiu, e a tela mostra o que ele decidiu. */
  delimiter: z.string(),
  encoding: z.string(),
  headers: z.array(z.string()),
  /** O mapeamento efetivamente usado — o confirmado, ou a sugestão. */
  mapping: z.record(z.string(), z.number().int()),
  /** Campos obrigatórios sem coluna. Não-vazio ⇒ nada é gravado. */
  missing: z.array(z.string()),
  rowCount: z.number().int(),
  counts: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    ignored: z.number().int(),
    failed: z.number().int(),
  }),
  rows: z.array(ImportReportRowSchema),
  /** `true` quando o relatório não traz todas as linhas bem-sucedidas. */
  truncated: z.boolean(),
  /**
   * Este mesmo arquivo (por SHA-256) já foi aplicado antes. **Avisa, não bloqueia**:
   * reaplicar depois de corrigir algumas linhas é o caminho normal, e travar pelo hash
   * obrigaria a mexer no arquivo só para mudar o hash.
   */
  previousBatch: z.object({ id: z.uuid(), createdAt: z.iso.datetime() }).nullable(),
  /** Só no `apply`: o lote gravado, que é o que o desfazer recebe. */
  batchId: z.uuid().nullish(),
})
export type ImportReport = z.infer<typeof ImportReportSchema>

export const ImportFieldSchema = z.object({
  field: z.string(),
  label: z.string(),
  required: z.boolean(),
  /** Uma célula de exemplo — é o que o modelo CSV mostra. */
  example: z.string(),
  /** Uma frase quando o campo precisa de explicação. */
  hint: z.string().nullable(),
})

export const ImportEntityInfoSchema = z.object({
  entity: ImportEntitySchema,
  label: z.string(),
  description: z.string(),
  fields: z.array(ImportFieldSchema),
  /** O modelo CSV do passo, montado do mesmo catálogo que valida a carga. */
  template: z.string(),
})
export type ImportEntityInfo = z.infer<typeof ImportEntityInfoSchema>

export const ImportBatchSchema = z.object({
  id: z.uuid(),
  entity: ImportEntitySchema,
  fileName: z.string(),
  rowCount: z.number().int(),
  createdCount: z.number().int(),
  updatedCount: z.number().int(),
  ignoredCount: z.number().int(),
  failedCount: z.number().int(),
  status: z.enum(['APLICADO', 'DESFEITO']),
  createdAt: z.iso.datetime(),
  undoneAt: z.iso.datetime().nullable(),
  rows: z.array(ImportReportRowSchema).optional(),
})
export type ImportBatch = z.infer<typeof ImportBatchSchema>

export const ImportBatchListSchema = z.object({ items: z.array(ImportBatchSchema) })

export const ImportUndoResultSchema = z.object({
  batchId: z.uuid(),
  /** Quantas linhas criadas pelo lote foram removidas. */
  removed: z.number().int(),
  /**
   * Quantos tutores o lote criou e que **ficaram**. Tutor não é desfeito: ver a nota em
   * `import/service.ts`.
   */
  keptTutors: z.number().int(),
})
export type ImportUndoResult = z.infer<typeof ImportUndoResultSchema>
