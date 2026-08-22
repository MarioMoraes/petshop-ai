import { Prisma, decryptPlatform, encryptPlatform, getPrisma, hashEmail } from '@petshop/db'
import { conflict } from '../../lib/errors.js'
import { getClerk } from '../../lib/clerk.js'
import { logger } from '../../lib/logger.js'

/**
 * Espelho local do usuário do Clerk.
 *
 * `users` é tabela global (sem `tenant_id`, sem RLS): o mesmo usuário pertence a N
 * tenants (RN-01). Por isso o acesso aqui não passa por `withTenant`.
 *
 * A sincronização por webhook é MOD-IDENT-03, que não está nesta entrega. Até lá o
 * espelho é criado sob demanda: na primeira vez que o usuário aparece numa requisição,
 * buscamos o perfil no Clerk e gravamos. O `clerkSyncedAt` já fica preparado para a
 * comparação de versão que a RN-09 vai exigir do webhook.
 */

export interface LocalUser {
  id: string
  clerkUserId: string
  email: string
  fullName: string
  avatarUrl: string | null
  mfaEnabled: boolean
}

export async function ensureLocalUser(clerkUserId: string): Promise<LocalUser> {
  const prisma = getPrisma()

  const existing = await prisma.user.findUnique({ where: { clerkUserId } })
  if (existing) {
    return {
      id: existing.id,
      clerkUserId: existing.clerkUserId,
      email: decryptPlatform(existing.emailEncrypted),
      fullName: existing.fullName,
      avatarUrl: existing.avatarUrl,
      mfaEnabled: existing.mfaEnabled,
    }
  }

  const profile = await getClerk().getUser(clerkUserId)

  try {
    const created = await prisma.user.create({
      data: {
        clerkUserId,
        emailEncrypted: encryptPlatform(profile.email),
        emailHash: hashEmail(profile.email),
        fullName: profile.fullName.slice(0, 120),
        avatarUrl: profile.avatarUrl,
        mfaEnabled: profile.mfaEnabled,
        clerkSyncedAt: new Date(),
      },
    })
    logger.info({ userId: created.id }, 'espelho local do usuário criado')
    return {
      id: created.id,
      clerkUserId,
      email: profile.email,
      fullName: created.fullName,
      avatarUrl: created.avatarUrl,
      mfaEnabled: created.mfaEnabled,
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined)?.join(',') ?? ''
      if (target.includes('email_hash')) {
        // RN-12: o e-mail já pertence a outro usuário. Não dá para adivinhar qual é
        // o dono legítimo — o caso vai para intervenção humana.
        logger.error({ clerkUserId }, 'colisão de e-mail entre usuários do Clerk')
        throw conflict('Este e-mail já está associado a outra conta')
      }
      // Corrida entre duas requisições do mesmo usuário: a outra ganhou.
      const raced = await prisma.user.findUnique({ where: { clerkUserId } })
      if (raced) {
        return {
          id: raced.id,
          clerkUserId,
          email: profile.email,
          fullName: raced.fullName,
          avatarUrl: raced.avatarUrl,
          mfaEnabled: raced.mfaEnabled,
        }
      }
    }
    throw error
  }
}
