import { getMaintenancePrisma } from '@petshop/db'

/**
 * A retenção de `job_runs`: trinta dias.
 *
 * A tabela ganha uma linha por execução de cada job da grade — alguns rodam a cada minuto
 * —, e até 2026-11-03 ninguém a apagava: era 80% do dump de produção, sem um cliente
 * pagando. Ela serve à tela de saúde e à leitura de uma falha recente, não de arquivo; o
 * que se quer ver de três meses atrás está no log.
 *
 * **A última execução e a última bem-sucedida de cada job ficam, mesmo velhas.** São as
 * duas linhas que o painel de saúde lê (`checkJobs` em `health.ts`): um job parado há
 * quarenta dias precisa continuar aparecendo como parado há quarenta dias, e não como
 * "nunca rodou" — a diferença entre um defeito e uma configuração. O job mais espaçado da
 * grade é semanal, então trinta dias ainda guardam quatro execuções dele.
 */
export const JOB_RUNS_RETENTION_DAYS = 30

export async function pruneJobRuns(now: Date = new Date()): Promise<{ removed: number }> {
  const corte = new Date(now.getTime() - JOB_RUNS_RETENTION_DAYS * 86_400_000)

  const removed = await getMaintenancePrisma().$executeRaw`
    DELETE FROM job_runs r
     WHERE r.started_at < ${corte}
       AND r.id NOT IN (
         SELECT DISTINCT ON (name) id FROM job_runs ORDER BY name, started_at DESC
       )
       AND r.id NOT IN (
         SELECT DISTINCT ON (name) id FROM job_runs WHERE status = 'OK'
          ORDER BY name, started_at DESC
       )
  `
  return { removed }
}
