import { createClerkClient } from '@clerk/backend'
import { loadEnv } from '../env.js'

/**
 * Fronteira com o Clerk.
 *
 * Todo acesso ao Clerk passa por aqui — é o único módulo que os testes substituem,
 * o que permite rodar a suíte inteira sem chaves reais.
 */

export interface ClerkOrganization {
  id: string
  slug: string | null
  name: string
}

export interface ClerkUser {
  id: string
  email: string
  fullName: string
  avatarUrl: string | null
  mfaEnabled: boolean
}

export interface ClerkPort {
  /** Cria a Organization do tenant. O slug é o mesmo do tenant local. */
  createOrganization(input: {
    name: string
    slug: string
    createdBy: string
    publicMetadata: Record<string, unknown>
  }): Promise<ClerkOrganization>

  /** Usado pelo retry para descobrir se a Organization já foi criada (AC-03). */
  findOrganizationBySlug(slug: string): Promise<ClerkOrganization | null>

  getUser(clerkUserId: string): Promise<ClerkUser>

  /**
   * Grava `permVersion` no metadata público do membership, de onde o JWT template
   * do Clerk o publica como claim para o gateway comparar (RN-03).
   */
  setMembershipPermVersion(input: {
    organizationId: string
    clerkUserId: string
    permVersion: number
  }): Promise<void>
}

export class ClerkNotFoundError extends Error {}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  return status === 404
}

function createRealClerkPort(): ClerkPort {
  const clerk = createClerkClient({ secretKey: loadEnv().CLERK_SECRET_KEY })

  return {
    async createOrganization({ name, slug, createdBy, publicMetadata }) {
      const org = await clerk.organizations.createOrganization({
        name,
        slug,
        createdBy,
        publicMetadata,
      })
      return { id: org.id, slug: org.slug, name: org.name }
    },

    async findOrganizationBySlug(slug) {
      try {
        const org = await clerk.organizations.getOrganization({ slug })
        return { id: org.id, slug: org.slug, name: org.name }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async getUser(clerkUserId) {
      const user = await clerk.users.getUser(clerkUserId)
      const primary =
        user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
        user.emailAddresses[0]
      if (!primary) {
        throw new ClerkNotFoundError(`Usuário ${clerkUserId} não tem e-mail no Clerk`)
      }
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
      return {
        id: user.id,
        email: primary.emailAddress,
        fullName: fullName || primary.emailAddress,
        avatarUrl: user.imageUrl ?? null,
        mfaEnabled: user.twoFactorEnabled ?? false,
      }
    },

    async setMembershipPermVersion({ organizationId, clerkUserId, permVersion }) {
      await clerk.organizations.updateOrganizationMembershipMetadata({
        organizationId,
        userId: clerkUserId,
        publicMetadata: { permVersion },
      })
    },
  }
}

let port: ClerkPort | null = null

export function getClerk(): ClerkPort {
  port ??= createRealClerkPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setClerkPort(next: ClerkPort | null): void {
  port = next
}
