import { getMaintenancePrisma, hashSearchable, withTenant } from '@petshop/db'
import { openCipher } from './crypto.js'

/**
 * Os aparelhos do app do tutor (etapa 9 — push).
 *
 * Moram no MOD-NOTIF porque são endereço de entrega, como o telefone é para o
 * WhatsApp: quem manda é o motor, e o Portal só registra — pela
 * `modules/portal/devices-port.ts`.
 *
 * **Um aparelho tem um dono só, em todos os tenants.** O token é do app instalado, e o
 * celular que passa para outra conta — outro tutor, ou o mesmo tutor noutro petshop —
 * muda a linha de dono. É o índice único global em `token_hash` que obriga isso, e é
 * por ele ser global que a troca passa pelo cliente de manutenção: a linha antiga pode
 * estar noutro tenant, onde a RLS desta transação não enxerga.
 */

export function hashPushToken(token: string): string {
  return hashSearchable('push:token', token)
}

export interface DeviceOwner {
  tenantId: string
  tutorId: string
}

export async function registerDevice(
  owner: DeviceOwner,
  token: string,
  platform: 'ANDROID' | 'IOS',
): Promise<void> {
  const tokenHash = hashPushToken(token)

  // O aparelho que era de outra ficha deixa de ser. Apagar, e não transferir: o
  // histórico de entregas daquela linha é da ficha anterior, e não pode aparecer como
  // se tivesse ido a este tutor.
  await getMaintenancePrisma().pushDevice.deleteMany({
    where: {
      tokenHash,
      NOT: { tenantId: owner.tenantId, tutorId: owner.tutorId },
    },
  })

  await withTenant(owner.tenantId, async (tx) => {
    const cipher = await openCipher(tx, owner.tenantId)
    await tx.pushDevice.upsert({
      where: { tokenHash },
      create: {
        tenantId: owner.tenantId,
        tutorId: owner.tutorId,
        tokenEncrypted: cipher.encrypt(token),
        tokenHash,
        platform,
      },
      // O mesmo aparelho voltando: um token revogado pelo FCM que reaparece foi
      // reinstalado, e volta a valer.
      update: { lastSeenAt: new Date(), revokedAt: null, platform },
    })
  })
}

/**
 * Ao sair da conta. Só apaga o que é deste tutor: um token alheio não diz nada — e
 * responder diferente para ele contaria que o aparelho existe noutra ficha.
 */
export async function forgetDevice(owner: DeviceOwner, token: string): Promise<void> {
  await withTenant(owner.tenantId, (tx) =>
    tx.pushDevice.deleteMany({
      where: { tokenHash: hashPushToken(token), tutorId: owner.tutorId },
    }),
  )
}

