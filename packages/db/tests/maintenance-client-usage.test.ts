import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * MOD-IDENT-07 — o cliente de manutenção lê, não escreve.
 *
 * `getMaintenancePrisma()` conecta como `app_maintenance`, papel COM BYPASSRLS: para
 * ele, nenhuma política RLS vale. Isso é necessário — descobrir trabalho pendente é
 * cross-tenant por natureza (varrer faltas, corridas vencidas, leads sem finalidade).
 * Agir sobre o que se descobriu não é.
 *
 * O contrato que este teste trava:
 *
 * > **Varredura cross-tenant, escrita por tenant.** O job lê com o cliente de
 * > manutenção — `$queryRaw` devolvendo `(id, tenant_id)` — e escreve dentro de
 * > `withTenant()`, onde a RLS volta a valer e limita o alcance.
 *
 * Sem isso, um `updateMany` no cliente de manutenção com `WHERE` só de data atinge
 * todos os tenants numa instrução: um erro de aritmética ou uma constante mal
 * configurada destrói dado da base inteira, e não há nada para conter o estrago. Com
 * a escrita dentro de `withTenant()`, a política é o teto — o pior caso fica em um
 * tenant.
 *
 * Este teste nasceu de uma violação real: `runLeadRetention` apagava PII de leads com
 * três `updateMany` cross-tenant. Passava em todos os testes, porque com um tenant só
 * o comportamento é idêntico — a diferença aparece justamente quando algo dá errado.
 * Por isso a checagem é estática: o que precisa ser garantido é a forma do código, não
 * o resultado do caminho feliz.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * As exceções declaradas. Manter a lista curta é metade do valor deste teste: uma
 * entrada nova aqui é uma decisão que alguém precisa justificar na revisão.
 *
 * - `packages/db/src/platform.ts` — as operações de plataforma (resolver tenant por
 *   slug, expirar convite) são cross-tenant por definição. Vivem isoladas neste
 *   arquivo, dentro de `runInPlatformScope()`; concentrá-las é o que as torna
 *   revisáveis.
 * - `packages/job-scheduler/src/lease.ts` — escreve em `job_leases` e `job_runs`, que
 *   são tabelas de plataforma: não têm `tenant_id`, estão fora de `RLS_MODELS` de
 *   propósito e não pertencem a tenant nenhum. Não há contexto a respeitar.
 */
const ALLOWED_WRITERS = new Set([
  'packages/db/src/platform.ts',
  'packages/job-scheduler/src/lease.ts',
  /**
   * As três escritas de plataforma que já existiam quando este teste passou a ser
   * executado de novo, e que a varredura não tinha como distinguir:
   *
   * - `backend/app/src/shared/audit.ts` — a trilha de uma ação **da plataforma**, com
   *   `tenant_id` nulo. A política de `audit_logs` é `tenant_id = current_tenant_id()`,
   *   que é falso para NULL: como `app_user`, a linha seria recusada.
   * - `packages/service-kit/src/security-events.ts` — o mesmo caso, e só no ramo em que
   *   `tenantId === null`; o ramo com tenant já escreve dentro de `withTenant`.
   * - `backend/app/src/modules/security/retention.ts` — o expurgo de 24 meses do
   *   MOD-SEC-08, que é a **única** exceção nomeada ao append-only de `audit_logs`: o
   *   schema concede `DELETE` a `app_maintenance` e a ninguém mais.
   */
  'backend/app/src/shared/audit.ts',
  'packages/service-kit/src/security-events.ts',
  'backend/app/src/modules/security/retention.ts',
  /**
   * MOD-ADMIN-05 e 06 — a série de métricas e o estado das regras.
   *
   * As duas tabelas são de plataforma: `tenant_id` nelas é rótulo de agregação, não dono
   * (ver `PLATFORM_MODELS` em `rls-models-sync.test.ts`), e boa parte das linhas nasce com
   * ele nulo — `withTenant` não teria contexto a oferecer. O que este teste protege é dado
   * de estabelecimento; o raio de um erro aqui é telemetria.
   */
  'backend/app/src/modules/platform/metrics.ts',
  'backend/app/src/modules/platform/alerts.ts',
  /**
   * A tabela de preços do console. `plan_prices` tem o **plano** por chave primária e
   * nenhuma coluna de tenant: ela é o preço de tabela do produto, que a equipe PetShop AI
   * mantém e todo estabelecimento lê. Não há contexto de tenant a respeitar porque não há
   * dono — e o que protege o valor já contratado é o congelamento em
   * `tenant_subscriptions.price_cents`, não a RLS.
   */
  'backend/app/src/modules/platform/prices.ts',
])

/** Operações do Prisma que gravam. `$executeRaw` entra: é escrita crua. */
const WRITE_OPS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  '\\$executeRaw',
  '\\$executeRawUnsafe',
]

const SCAN_ROOTS = ['backend', 'packages']

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // `dist` e `generated` são saída de build; `tests` monta cenário e pode gravar
      // à vontade com o papel de dono.
      if (['node_modules', 'dist', 'generated', 'tests', '.turbo'].includes(entry.name)) continue
      sourceFiles(full, found)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full)
    }
  }
  return found
}

interface Violation {
  file: string
  line: number
  snippet: string
}

/**
 * Procura escrita a partir do cliente de manutenção, nas duas formas em que ela
 * aparece: encadeada (`getMaintenancePrisma().siteLead.updateMany`) ou através de uma
 * variável local que recebeu o cliente (`const db = getMaintenancePrisma()` e depois
 * `db.siteLead.updateMany`). Foi a segunda forma que escondeu a violação original.
 */
function findViolations(file: string): Violation[] {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  const violations: Violation[] = []
  const ops = WRITE_OPS.join('|')

  // Aliases locais: `const db = getMaintenancePrisma()`.
  const aliases = [...source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*getMaintenancePrisma\(\)/g)]
    .map((m) => m[1])
    .filter((name): name is string => Boolean(name))

  const patterns = [
    new RegExp(`getMaintenancePrisma\\(\\)\\s*(?:\\.\\s*\\w+\\s*)*\\.\\s*(?:${ops})\\b`),
    ...aliases.map((alias) => new RegExp(`\\b${alias}\\s*(?:\\.\\s*\\w+\\s*)*\\.\\s*(?:${ops})\\b`)),
  ]

  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
    if (patterns.some((pattern) => pattern.test(line))) {
      violations.push({
        file: relative(repoRoot, file),
        line: index + 1,
        snippet: line.trim(),
      })
    }
  })

  return violations
}

describe('o cliente de manutenção (BYPASSRLS) não escreve fora de platform.ts', () => {
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)))

  it('encontra os arquivos para varrer', () => {
    // Uma varredura que não acha nada passaria vazia e daria falsa segurança.
    expect(files.length).toBeGreaterThan(100)
    // Um caminho de módulo, e não de serviço: a consolidação move os serviços para
    // dentro do backend único, e a âncora precisa sobreviver a isso.
    expect(files.some((f) => f.includes(join('modules', 'site')))).toBe(true)
  })

  it('nenhum módulo grava com o cliente de manutenção', () => {
    const violations = files
      .filter((file) => !ALLOWED_WRITERS.has(relative(repoRoot, file)))
      .flatMap(findViolations)
      .map((v) => `${v.file}:${v.line} — ${v.snippet}`)
      .sort()

    expect(violations).toEqual([])
  })
})
