import { afterAll, describe, expect, it } from 'vitest'
import { disconnectHelpers, ownerPrisma } from './helpers.js'

/**
 * MOD-IDENT-07 — o RLS como o banco migrado o aplica, e não como as migrations o dizem.
 *
 * `rls-models-sync.test.ts` lê o texto das migrations e soma os `ENABLE ROW LEVEL
 * SECURITY`. Ele não vê três coisas que tiram a proteção sem tirar o `ENABLE`:
 *
 * - o `FORCE` ausente — sem ele o **dono** da tabela passa por cima da política;
 * - a política ausente, ou uma que não compara com `current_tenant_id()` (`USING (true)`);
 * - o `DISABLE ROW LEVEL SECURITY` que o `prisma migrate dev` gera por conta própria
 *   (`prisma/migrations/README.md`, "A pegadinha"), numa migration posterior.
 *
 * O catálogo responde pelas três de uma vez, depois de todas as migrations aplicadas.
 */

/**
 * Têm `tenant_id` e ficam sem RLS de propósito: a coluna é rótulo de agregação, e não
 * dono. A justificativa mora em `PLATFORM_MODELS` (`rls-models-sync.test.ts`), e a
 * terceira exceção precisa passar por lá antes de entrar aqui.
 */
const SEM_RLS_DE_PROPOSITO = new Set(['platform_alerts', 'platform_metrics'])

interface Linha {
  tabela: string
  ligado: boolean
  forcado: boolean
  politicas: string[]
}

afterAll(disconnectHelpers)

describe('toda tabela com `tenant_id` está sob RLS no banco migrado', () => {
  it('ENABLE, FORCE e política por `current_tenant_id()`', async () => {
    const linhas = await ownerPrisma.$queryRaw<Linha[]>`
      SELECT c.relname AS tabela,
             c.relrowsecurity AS ligado,
             c.relforcerowsecurity AS forcado,
             COALESCE(
               (SELECT array_agg(COALESCE(p.qual, ''))
                  FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname),
               '{}'
             ) AS politicas
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
         )
       ORDER BY 1`

    // Uma tabela some daqui se a coluna mudar de nome; o piso evita o teste que passa vazio.
    expect(linhas.length).toBeGreaterThan(50)

    const desprotegidas = linhas
      .filter((linha) => !SEM_RLS_DE_PROPOSITO.has(linha.tabela))
      .filter(
        (linha) =>
          !linha.ligado ||
          !linha.forcado ||
          linha.politicas.length === 0 ||
          linha.politicas.some((qual) => !qual.includes('current_tenant_id()')),
      )
      .map((linha) => linha.tabela)

    expect(desprotegidas).toEqual([])
  })

  it('as exceções continuam existindo — senão a lista vira cheque em branco', async () => {
    const tabelas = await ownerPrisma.$queryRaw<{ tabela: string }[]>`
      SELECT table_name AS tabela FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'`
    const existentes = new Set(tabelas.map((linha) => linha.tabela))

    for (const tabela of SEM_RLS_DE_PROPOSITO) expect(existentes.has(tabela), tabela).toBe(true)
  })
})
