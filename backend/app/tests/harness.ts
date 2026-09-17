import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import type { FastifyInstance } from 'fastify'
import type { SessionClaims } from '../src/auth/clerk-token.js'

/**
 * Harness do backend.
 *
 * Sobe o processo de verdade contra o banco de testes, com **um** dublê na ponta: o
 * verificador de token do Clerk.
 *
 * Eram dois até a fatia 11. O outro era um serviço de destino que devolvia o que recebia,
 * e servia para inspecionar o contexto assinado que o gateway encaminhava. Não há mais
 * encaminhamento, e a inspeção virou o que sempre deveria ter sido: o efeito da rota.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(repoRoot, '.env'), quiet: true })
// Banco de testes próprio deste pacote: o turbo roda as suítes em paralelo.
process.env.TEST_DATABASE_NAME = 'petshop_test_gateway'

const { useTestDatabase, createOwnerClient, truncateBusinessTables } = await import(
  '@petshop/db/testing'
)
type OwnerClient = import('@petshop/db').PrismaClient
useTestDatabase()

// Broker, agendador e cache ficam fora: os testes verificam o efeito no banco, e
// subir RabbitMQ/Redis por teste só adicionaria intermitência.
//
// **Sem Redis, o rate limit do site libera todo envio** (`withinRateLimit` degrada
// aberto de propósito: lead perdido é cliente perdido). O teste do 429 liga um dublê.
process.env.DISABLE_EVENTS = 'true'
process.env.DISABLE_JOBS = 'true'
process.env.DISABLE_REDIS = 'true'
process.env.NODE_ENV = 'test'
process.env.CLERK_SECRET_KEY ||= 'sk_test_harness'

export const ownerPrisma: OwnerClient = createOwnerClient()

const { setStoragePort } = await import('../src/shared/storage.js')
const { clearTenantKeyCache } = await import('@petshop/db')

// ─── O app ───────────────────────────────────────────────────────────────────

let gateway: FastifyInstance | null = null

/**
 * O app do processo — gateway e módulos juntos.
 *
 * Sobe o app de verdade: os escopos do Fastify, o handler de erro, o RLS e o banco. A
 * separação entre superfície pública e administrativa **só existe na montagem do
 * app**; um harness que chamasse as funções de módulo direto não provaria nada sobre
 * ela.
 */
export async function getApp(): Promise<FastifyInstance> {
  if (gateway) return gateway

  /**
   * **Antes de montar o app, e não por causa de URL de serviço.**
   *
   * Cada `tests/<modulo>/fixtures.ts` acerta o `process.env` do módulo dele no topo — o
   * segredo do webhook do Resend, as credenciais da Evolution — e a essa altura o
   * `loadEnv()` já foi chamado por `shared/logger.ts`, no import do próprio harness. Sem
   * derrubar o cache, o app subiria com o ambiente de antes, e o teste falharia pelo motivo
   * errado: assinatura válida recusada porque o processo não conhece o segredo.
   */
  const { resetEnvCache } = await import('../src/config/env.js')
  resetEnvCache()

  const { buildApp } = await import('../src/app.js')
  gateway = await buildApp()
  await gateway.ready()
  return gateway
}

/** Nome antigo, mantido para a suíte de encaminhamento. */
export const getGateway = getApp

export async function closeHarness(): Promise<void> {
  await gateway?.close()
  gateway = null
  setStoragePort(null)
  const { disconnectPrisma } = await import('@petshop/db')
  await Promise.all([ownerPrisma.$disconnect(), disconnectPrisma()])
}

export async function resetDatabase(): Promise<void> {
  await truncateBusinessTables(ownerPrisma)
  clearTenantKeyCache()
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

const tokens = new Map<string, SessionClaims>()

/** Registra um token válido no verificador falso e devolve a string do token. */
export function givenToken(claims: {
  clerkUserId: string
  clerkOrgId?: string | null
  permVersion?: number | null
  /**
   * O claim de segundo fator (MOD-SEC-01).
   *
   * **O padrão é `true`, e não `false`.** Um token de teste representa uma sessão que
   * já entrou; deixá-lo sem MFA faria toda escrita de administrador nas 37 suítes
   * depender da carência, e a suíte passaria a medir o relógio em vez do que
   * pretende. Quem exercita o gate diz `mfaEnabled: false` explicitamente. `null` é a
   * terceira posição: o template do Clerk sem o claim.
   */
  mfaEnabled?: boolean | null
}): string {
  const token = `tok_${randomBytes(8).toString('hex')}`
  tokens.set(token, {
    clerkUserId: claims.clerkUserId,
    clerkOrgId: claims.clerkOrgId ?? null,
    permVersion: claims.permVersion ?? null,
    mfaEnabled: claims.mfaEnabled === undefined ? true : claims.mfaEnabled,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
  return token
}

const { setTokenVerifier, InvalidTokenError } = await import('../src/auth/clerk-token.js')

setTokenVerifier(async (token) => {
  const claims = tokens.get(token)
  if (!claims) throw new InvalidTokenError('Token desconhecido')
  return claims
})

// ─── Cenário no banco ────────────────────────────────────────────────────────

export interface SeededTenant {
  tenantId: string
  clerkOrgId: string
  slug: string
}

export async function seedTenant(
  slug: string,
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' = 'ACTIVE',
  /**
   * `STARTER` por padrão: o núcleo exercita a porta, e a porta é a mesma em todo plano.
   * Cenário que chega a recurso pago (o Portal, no `gateway.test.ts`) pede o plano que o
   * libera — senão ele testaria o bloqueio por plano, e não o que diz testar.
   */
  plan: 'STARTER' | 'PRO' | 'ENTERPRISE' = 'STARTER',
): Promise<SeededTenant> {
  const tenantId = randomUUID()
  const clerkOrgId = `org_${randomBytes(8).toString('hex')}`
  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: `Petshop ${slug}`,
      status,
      plan,
      provisioningKey: randomUUID(),
      clerkOrgId,
    },
  })
  return { tenantId, clerkOrgId, slug }
}

/**
 * Uma ficha de tutor com acesso ao Portal já vinculado.
 *
 * O `phoneEncrypted` é literal porque o gateway não decifra nada — o que ele lê é o
 * `portal_user_id`, e é só isso que este cenário precisa ter de verdade.
 */
export async function seedPortalTutor(
  tenantId: string,
  userId: string,
): Promise<{ tutorId: string }> {
  const { withTenant } = await import('@petshop/db')
  const tutor = await withTenant(tenantId, (tx) =>
    tx.tutor.create({
      data: {
        tenantId,
        fullName: 'Maria Souza',
        phoneEncrypted: 'v1:x:x:x',
        phoneHash: `hash-${randomBytes(6).toString('hex')}`,
        portalUserId: userId,
      },
      select: { id: true },
    }),
  )
  return { tutorId: tutor.id }
}

export async function seedMember(
  tenantId: string,
  roleKey: string,
): Promise<{ userId: string; clerkUserId: string; membershipId: string }> {
  const { encryptPlatform, hashEmail } = await import('@petshop/db')
  const email = `${randomBytes(4).toString('hex')}@petshop.test`
  const clerkUserId = `user_${randomBytes(8).toString('hex')}`
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId,
      emailEncrypted: encryptPlatform(email),
      emailHash: hashEmail(email),
      fullName: 'Membro de Teste',
    },
  })
  const membership = await ownerPrisma.membership.create({
    data: {
      tenantId,
      userId: user.id,
      roleKey,
      status: 'ACTIVE',
      /**
       * MOD-SEC-03 — o mesmo prazo que o produto concede a quem vira administrador.
       *
       * Sem isto, todo `TENANT_ADMIN` semeado nasceria com a coluna nula, que é o
       * estado de "sem prazo" — e as escritas das outras 37 suítes passariam a
       * depender do claim de MFA do token em vez do que cada uma pretende provar.
       */
      mfaGraceUntil: roleKey === 'TENANT_ADMIN' ? new Date(Date.now() + 7 * 86_400_000) : null,
    },
  })
  return { userId: user.id, clerkUserId, membershipId: membership.id }
}

/** Storage em memória: o upload é exercitado de ponta a ponta, sem bucket. */
export function useMemoryStorage(): Map<string, { body: Buffer; contentType: string }> {
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  setStoragePort({
    async put(key, body, contentType) {
      objects.set(key, { body, contentType })
    },
    async read(key) {
      return objects.get(key) ?? null
    },
    async signedUrl(key) {
      // O dublê não assina nada: devolve um endereço reconhecível, que é o que os
      // testes do álbum conferem. Quem exercita a assinatura de verdade é o R2.
      return `memoria://${key}`
    },
    async remove(keys) {
      for (const key of keys) objects.delete(key)
    },
  })
  return objects
}

// ─── Chamadas ────────────────────────────────────────────────────────────────

/**
 * Quem chama, do ponto de vista do processo consolidado.
 *
 * **Deixou de ser um contexto montado à mão.** Enquanto o site era um serviço, o
 * harness assinava um `ServiceAuthContext` com a lista exata de permissões que o teste
 * queria exercitar. Agora a identidade entra pela mesma porta da produção: um token, o
 * membership no banco e a matriz de papéis resolvendo as permissões. O teste ficou mais
 * caro de montar e passou a provar também que o papel concede o que o §9 diz que
 * concede.
 */
/** O mínimo que um cenário precisa expor para montar um chamador. */
export interface TenantRef {
  tenantId: string
  clerkOrgId: string
}

export interface Caller {
  clerkUserId: string
  /**
   * A Organization ativa no token — o tenant.
   *
   * `null` é um estado legítimo, e não a ausência de um dado: é quem está autenticado
   * e ainda não é membro de estabelecimento nenhum. O MOD-IDENT tem três rotas que só
   * existem para essa pessoa (criar o primeiro tenant, espiar um convite, aceitá-lo), e
   * `resolveSession` trata o caso desde sempre. Antes da fatia 7 nenhum teste do
   * gateway precisava expressá-lo.
   */
  clerkOrgId: string | null
  /**
   * O claim de segundo fator (MOD-SEC-01).
   *
   * Ausente quer dizer `true`, que é o estado de quem já entrou. Quem exercita o gate
   * do MOD-SEC-02 diz `false` — ou `null`, para o template do Clerk sem o claim.
   */
  mfaEnabled?: boolean | null
}

export interface InjectOptions extends Caller {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

/**
 * Os headers de uma chamada autenticada.
 *
 * Um `Authorization: Bearer` de verdade, com o token registrado no verificador falso —
 * onde antes iam os seis headers assinados com HMAC do contrato gateway→serviço.
 */
export function authHeaders(caller: Caller): Record<string, string> {
  const token = givenToken({
    clerkUserId: caller.clerkUserId,
    clerkOrgId: caller.clerkOrgId,
    ...(caller.mfaEnabled !== undefined ? { mfaEnabled: caller.mfaEnabled } : {}),
  })
  return { authorization: `Bearer ${token}` }
}

/** Chamada autenticada, como o Admin a faz. */
export async function callApi(options: InjectOptions) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: { ...authHeaders(options), ...options.headers },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/** Chamada **anônima**, como o Next a faz ao renderizar a página. */
export async function callPublic(options: {
  method: 'GET' | 'POST'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/**
 * Um membro novo do tenant, com o papel pedido.
 *
 * As permissões saem da matriz do MOD-IDENT-04, e não de uma lista escrita no teste —
 * é o que faz "quem tosa não vê a fila de contatos" continuar verdadeiro quando a
 * matriz mudar, em vez de continuar passando contra uma lista congelada.
 */
export async function asRole(fixture: TenantRef, roleKey: string): Promise<Caller> {
  const { clerkUserId } = await seedMember(fixture.tenantId, roleKey)
  return { clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/**
 * Revoga uma permissão de um papel **neste tenant** (`tenant_role_overrides`).
 *
 * É o mecanismo do MOD-IDENT-04 para ajustar a matriz padrão, e a única forma honesta
 * de montar um cenário que a matriz não produz sozinha — como uma recepção que vê a
 * fila de contatos mas não abre ficha de tutor. Antes da consolidação o teste
 * escrevia a lista de permissões à mão; agora monta a configuração de verdade que
 * levaria àquele contexto.
 */
export async function revokePermission(
  fixture: TenantRef,
  roleKey: string,
  permissionKey: string,
): Promise<void> {
  await ownerPrisma.tenantRoleOverride.create({
    data: { tenantId: fixture.tenantId, roleKey, permissionKey, granted: false },
  })
}

/**
 * Concede a um papel uma permissão que a matriz padrão não lhe dá — o outro lado de
 * `revokePermission`, e o mesmo `tenant_role_overrides`.
 *
 * É o que torna alcançável um cenário que a matriz sozinha esconde: `team:remove` só
 * existe em `TENANT_ADMIN`, e por isso a guarda do último administrador (RN-02) não
 * dispara no caminho da remoção — quem pode remover **é** um administrador ativo, e
 * portanto nunca é o último. Com a permissão concedida à recepção, a regra volta a ter
 * como ser exercida.
 */
export async function grantPermission(
  fixture: TenantRef,
  roleKey: string,
  permissionKey: string,
): Promise<void> {
  await ownerPrisma.tenantRoleOverride.create({
    data: { tenantId: fixture.tenantId, roleKey, permissionKey, granted: true },
  })
}
