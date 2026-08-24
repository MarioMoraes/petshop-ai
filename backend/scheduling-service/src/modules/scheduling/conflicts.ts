import { Prisma, type TenantTransaction } from '@petshop/db'

/**
 * Conflito e capacidade (RN-02 e RN-13).
 *
 * Duas ideias governam este arquivo, e as duas são contra-intuitivas.
 *
 * **1. Conflito não é "existe sobreposição".** É `count(sobreposições) >= limite`
 * (decisão 7 de negócio): o banhista lava um pet, põe para secar e começa o próximo,
 * então `max_concurrent_pets = 3` significa três janelas simultâneas legítimas. É por
 * isso que **não** se usa `EXCLUDE USING GIST` — a exclusão proibiria qualquer
 * sobreposição e quebraria a operação real do petshop.
 *
 * **2. Contar e inserir precisa ser atômico.** Sem isso, dois atendentes salvando o
 * último lugar das 09:00 no mesmo instante ambos contam 2, ambos veem espaço e ambos
 * gravam — o AC-05 descreve exatamente essa corrida. `SELECT ... FOR UPDATE` não
 * resolve: não há linha a travar, porque a linha em disputa é justamente a que ainda
 * não existe (é um problema de *phantom read*). A garantia vem de isolamento
 * `SERIALIZABLE` na transação inteira, e o preço é ter de tratar 40001.
 */

/** Status que ocupam lugar na agenda. Cancelado e remarcado não ocupam. */
export const OCCUPYING_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
] as const

/**
 * Quantos atendimentos do profissional se sobrepõem à janela.
 *
 * A comparação é de **intervalos semiabertos**: `starts_at < fim AND ends_at > início`.
 * Um atendimento que termina exatamente quando o outro começa não conflita — 09:00–10:00
 * e 10:00–11:00 são sequenciais, e tratá-los como sobrepostos perderia metade da
 * capacidade do dia.
 *
 * `excludeAppointmentId` existe para a remarcação: ao mover um agendamento dentro da
 * própria janela, ele não pode conflitar consigo mesmo.
 */
export async function countOverlapping(
  tx: TenantTransaction,
  professionalId: string,
  startsAt: Date,
  endsAt: Date,
  excludeAppointmentId?: string,
): Promise<number> {
  return tx.appointment.count({
    where: {
      professionalId,
      status: { in: [...OCCUPYING_STATUSES] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
  })
}

/**
 * Erro de serialização do Postgres.
 *
 * 40001 é `serialization_failure` e 40P01 é `deadlock_detected`. Os dois significam a
 * mesma coisa para quem chamou: outra transação ganhou a corrida. Vira 409, nunca
 * 500 — o pedido não estava errado, só chegou em segundo lugar.
 */
export function isSerializationError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 é como o Prisma embrulha o conflito de escrita concorrente.
    if (error.code === 'P2034') return true
    const pgCode = (error.meta as { code?: string } | undefined)?.code
    if (pgCode === '40001' || pgCode === '40P01') return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('40001') || message.includes('could not serialize')
}
