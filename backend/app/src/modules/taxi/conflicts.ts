import { Prisma, type TenantTransaction } from '@petshop/db'
import { TAXI_OCCUPYING_STATUSES } from '@petshop/shared-types'

/**
 * Capacidade da van (RN-04 e RN-09).
 *
 * É a mesma ideia do RN-13 do MOD-AGENDA, com um sujeito diferente: o conflito não é
 * "existe sobreposição", é `count(sobreposições) >= capacidade`. Uma van leva quatro
 * pets ao mesmo tempo por definição — é o que ela é.
 *
 * A diferença em relação à agenda é a **capacidade efetiva**: lá vale só
 * `max_concurrent_pets` do profissional; aqui vale `min(motorista, veículo)`, porque
 * o mesmo motorista pode sair hoje com a van grande e amanhã com a pequena.
 *
 * `REQUESTED` não ocupa: corrida sem motorista não enche a van de ninguém.
 */

export async function countOverlappingRides(
  tx: TenantTransaction,
  driverId: string,
  windowStartsAt: Date,
  windowEndsAt: Date,
  excludeRideId?: string,
): Promise<number> {
  return tx.taxiRide.count({
    where: {
      driverId,
      status: { in: [...TAXI_OCCUPYING_STATUSES] },
      // Intervalos semiabertos, como na agenda: uma corrida que termina às 09:00 e
      // outra que começa às 09:00 são sequenciais, não simultâneas.
      windowStartsAt: { lt: windowEndsAt },
      windowEndsAt: { gt: windowStartsAt },
      ...(excludeRideId ? { id: { not: excludeRideId } } : {}),
    },
  })
}

/** RN-04: `min(motorista, veículo)`. Sem veículo, vale só o do motorista. */
export function effectiveCapacity(
  driverCapacity: number,
  vehicleCapacity: number | null,
): number {
  return vehicleCapacity === null ? driverCapacity : Math.min(driverCapacity, vehicleCapacity)
}

/**
 * Erro de serialização do Postgres.
 *
 * 40001 é `serialization_failure` e 40P01 é `deadlock_detected`. Para quem chamou os
 * dois dizem a mesma coisa: outra transação ganhou a corrida. Vira 409, nunca 500 —
 * o pedido não estava errado, só chegou em segundo lugar.
 */
export function isSerializationError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') return true
    const pgCode = (error.meta as { code?: string } | undefined)?.code
    if (pgCode === '40001' || pgCode === '40P01') return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('40001') || message.includes('could not serialize')
}
