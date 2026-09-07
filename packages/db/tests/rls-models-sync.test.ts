import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RLS_MODELS } from '../src/client.js'

/**
 * MOD-IDENT-07 — a lista `RLS_MODELS` não pode divergir do banco.
 *
 * `RLS_MODELS` é o que o guard de aplicação conhece; `ENABLE ROW LEVEL SECURITY` nas
 * migrations é o que o banco realmente protege. As duas listas são mantidas à mão, em
 * arquivos distintos, e nada além da disciplina de quem escreve a migration as
 * mantinha iguais.
 *
 * As duas direções de divergência machucam de formas diferentes:
 *
 * - **Tabela com RLS ausente do guard.** O banco aplica a política e devolve zero
 *   linhas quando não há `app.tenant_id`. O guard não reclama, então o serviço lê
 *   vazio e segue — o bug vira "sumiu o dado do cliente", longe da causa. É
 *   exatamente o resultado silencioso que o guard existe para eliminar.
 * - **Modelo no guard sem RLS no banco.** Pior: o guard dá a impressão de proteção
 *   que o banco não aplica. Qualquer caminho que não passe pelo cliente estendido
 *   (`$queryRaw`, o cliente de manutenção) lê tudo, de todos os tenants.
 *
 * Estes testes são estáticos de propósito: leem arquivo, não abrem conexão. Uma
 * migration nova que esqueça a lista falha aqui, no build, e não em produção.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = join(packageRoot, 'prisma', 'schema.prisma')
const migrationsDir = join(packageRoot, 'prisma', 'migrations')

/** Tabelas de plataforma: não têm dono de tenant, então RLS não se aplica a elas. */
const PLATFORM_MODELS = new Set([
  'User',
  'Role',
  'Permission',
  'RolePermission',
  // Um job varre todos os tenants por definição; exigir contexto dele seria negar o
  // que ele é.
  'JobLease',
  'JobRun',
])

function readSchema(): { modelToTable: Map<string, string>; modelsWithTenantId: Set<string> } {
  const schema = readFileSync(schemaPath, 'utf8')
  const modelToTable = new Map<string, string>()
  const modelsWithTenantId = new Set<string>()

  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = match
    if (!model || body === undefined) continue
    const mapped = /@@map\("([^"]+)"\)/.exec(body)
    modelToTable.set(model, mapped?.[1] ?? model)
    // `tenantId` como campo próprio é o que torna a linha pertencente a um tenant —
    // e portanto o que exige política.
    if (/^\s*tenantId\s/m.test(body)) modelsWithTenantId.add(model)
  }

  return { modelToTable, modelsWithTenantId }
}

/**
 * Tabelas que o banco protege com RLS **ao fim da história**.
 *
 * Não é a união dos `ENABLE`: uma migration posterior pode derrubar a tabela, e foi o
 * que aconteceu com `receipt_counters` quando a numeração virou `document_counters` na
 * fatia 1 do MOD-DOC. Somar só os `ENABLE` deixaria o teste cobrando guard para uma
 * tabela que não existe mais.
 *
 * Daí a ordem: os diretórios são lidos **ordenados**, porque o prefixo do nome é o
 * carimbo de tempo, e é ele que define o que veio antes.
 */
function readRlsTablesFromMigrations(): Set<string> {
  const tables = new Set<string>()

  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const name of entries) {
    let sql: string
    try {
      sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')
    } catch {
      continue
    }
    for (const match of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      if (match[1]) tables.add(match[1])
    }
    for (const match of sql.matchAll(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
    )) {
      if (match[1]) tables.delete(match[1])
    }
  }

  return tables
}

const { modelToTable, modelsWithTenantId } = readSchema()
const rlsTables = readRlsTablesFromMigrations()

describe('RLS_MODELS espelha as migrations', () => {
  it('lista apenas modelos que existem no schema.prisma', () => {
    // Um nome digitado errado entra no Set sem erro de tipo e nunca casa com
    // `model` no guard: a proteção some, calada.
    const desconhecidos = [...RLS_MODELS].filter((model) => !modelToTable.has(model))
    expect(desconhecidos).toEqual([])
  })

  it('cobre toda tabela que o banco protege com RLS', () => {
    const guardTables = new Set([...RLS_MODELS].map((model) => modelToTable.get(model)))
    const semGuard = [...rlsTables].filter((table) => !guardTables.has(table)).sort()
    expect(semGuard).toEqual([])
  })

  it('não exige contexto para tabela que o banco não protege', () => {
    const semRls = [...RLS_MODELS]
      .filter((model) => {
        const table = modelToTable.get(model)
        return table !== undefined && !rlsTables.has(table)
      })
      .sort()
    expect(semRls).toEqual([])
  })
})

describe('todo modelo com dono de tenant está protegido', () => {
  it('inclui no guard todo modelo que tem tenantId', () => {
    const desprotegidos = [...modelsWithTenantId].filter((model) => !RLS_MODELS.has(model)).sort()
    expect(desprotegidos).toEqual([])
  })

  it('só deixa fora do guard as tabelas de plataforma conhecidas', () => {
    // O contrário do teste acima: um modelo novo sem `tenantId` e sem RLS precisa ser
    // uma decisão consciente, declarada em PLATFORM_MODELS — não um esquecimento.
    const foraDoGuard = [...modelToTable.keys()]
      .filter((model) => !RLS_MODELS.has(model) && !PLATFORM_MODELS.has(model))
      .sort()
    expect(foraDoGuard).toEqual([])
  })
})
