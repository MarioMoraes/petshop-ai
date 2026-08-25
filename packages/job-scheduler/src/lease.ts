import { getMaintenancePrisma } from '@petshop/db'

/**
 * Exclusão mútua entre réplicas, por **lease em tabela**.
 *
 * O problema: com N réplicas do mesmo serviço no Swarm, todas acordam no mesmo minuto e
 * todas querem rodar o job. Expirar os pacotes duas vezes é inofensivo; marcar no-show
 * duas vezes não é, e reconciliar em paralelo produz alarme falso.
 *
 * **Por que não `pg_advisory_lock`.** O lock de sessão vive na conexão, e o Prisma faz
 * pool — não há como fixar a conexão do lock, então ele acabaria pendurado numa conexão
 * qualquer que o pool devolve a outro trabalho. A variante transacional
 * (`pg_try_advisory_xact_lock`) resolveria isso, mas só segura enquanto a transação
 * vive: manter uma transação aberta pelos dez minutos do job deixaria uma conexão
 * *idle in transaction*, travando o `VACUUM` e inflando a tabela.
 *
 * O lease não tem nenhum dos dois problemas: é uma instrução atômica, não segura
 * conexão nenhuma, e **expira sozinho** se o processo morrer no meio — que é o caso
 * que um lock em memória nunca cobre.
 */

export interface LeaseResult {
  acquired: boolean
  /** Quem está com o lease, quando não foi possível tomá-lo. Vai para o log. */
  heldBy?: string
}

interface ClaimRow {
  holder: string
}

/**
 * Toma o lease do job, ou desiste.
 *
 * `ON CONFLICT DO UPDATE … WHERE lease_until < now()` é o coração: a atualização só
 * acontece se o lease anterior já venceu, e o `RETURNING` só devolve linha se a
 * atualização aconteceu. Numa instrução, sem transação, sem corrida.
 */
export async function claimLease(
  name: string,
  holder: string,
  ttlMs: number,
): Promise<LeaseResult> {
  const prisma = getMaintenancePrisma()
  const leaseUntil = new Date(Date.now() + ttlMs)

  const claimed = await prisma.$queryRaw<ClaimRow[]>`
    INSERT INTO job_leases (name, holder, leased_at, lease_until)
    VALUES (${name}, ${holder}, now(), ${leaseUntil})
    ON CONFLICT (name) DO UPDATE
       SET holder = EXCLUDED.holder,
           leased_at = EXCLUDED.leased_at,
           lease_until = EXCLUDED.lease_until
     WHERE job_leases.lease_until < now()
    RETURNING holder
  `

  if (claimed.length > 0) return { acquired: true }

  const current = await prisma.$queryRaw<ClaimRow[]>`
    SELECT holder FROM job_leases WHERE name = ${name}
  `
  return { acquired: false, ...(current[0] ? { heldBy: current[0].holder } : {}) }
}

/**
 * Devolve o lease assim que o job termina.
 *
 * `WHERE holder = ...` impede que um processo lento libere o lease de quem o tomou
 * depois: se o job estourou o TTL e outra réplica já começou, a liberação do atrasado
 * não pode derrubar o lease do novo dono.
 */
export async function releaseLease(name: string, holder: string): Promise<void> {
  await getMaintenancePrisma().$executeRaw`
    UPDATE job_leases SET lease_until = now()
     WHERE name = ${name} AND holder = ${holder}
  `
}

export type JobStatus = 'OK' | 'FAILED' | 'TIMEOUT'

export interface JobRunRecord {
  name: string
  startedAt: Date
  finishedAt: Date
  status: JobStatus
  result?: unknown
  error?: string
}

/**
 * Registra a execução em `job_runs`.
 *
 * É a resposta a "o job rodou?", que sem isso só o log responderia — e log rotaciona.
 * `result` guarda o que o job devolveu (`{ marked: 3 }`, `{ expired: 0 }`), que é
 * exatamente o que se quer ver numa consulta de uma linha só.
 */
export async function recordRun(run: JobRunRecord): Promise<void> {
  // O `::"JobStatus"` é obrigatório: o parâmetro chega como texto e o Postgres não
  // converte para enum implicitamente numa posição de INSERT.
  await getMaintenancePrisma().$executeRaw`
    INSERT INTO job_runs (name, started_at, finished_at, status, result, error)
    VALUES (
      ${run.name},
      ${run.startedAt},
      ${run.finishedAt},
      ${run.status}::"JobStatus",
      ${run.result === undefined ? null : JSON.stringify(run.result)}::jsonb,
      ${run.error ?? null}
    )
  `
}
