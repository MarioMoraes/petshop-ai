import { randomUUID } from 'node:crypto'
import { DEFAULT_TERM_VERSION, PLATFORM_TERM_SEEDS, TERM_KINDS } from '@petshop/shared-types'
import { ownerPrisma, type Caller } from '../harness.js'

/**
 * Cenário do MOD-IMPORT — a carga da base do sistema anterior.
 *
 * As fixtures ficam por módulo, e não num harness só, porque os nomes colidem: cada
 * módulo tem o seu `givenTenant`, com as configurações que **ele** precisa que existam.
 * O núcleo compartilhado (`../harness.js`) guarda o que é do processo — o app, o banco,
 * o token e os chamadores por papel — e é reexportado aqui para que o teste importe de
 * um lugar só.
 *
 * O que este módulo precisa é o cenário dos **três** que ele alimenta: DEK para cifrar o
 * tutor, catálogo de domínio para o pet, serviço com preço para o agendamento. É a
 * consequência de compor — e é justamente por isso que a carga vale: se o cenário
 * mínimo aqui fosse menor, alguma regra estaria sendo pulada.
 */

export * from '../harness.js'

const { createTenantKey, withTenant } = await import('@petshop/db')

export interface TenantFixture {
  tenantId: string
  userId: string
  clerkUserId: string
  /** O gateway resolve o tenant pela Organization do token — daí o campo. */
  clerkOrgId: string
}

/**
 * Tenant, administrador, DEK e `tenant_settings`.
 *
 * O fuso é **UTC de propósito**: a jornada do profissional é hora de parede, e os
 * instantes das asserções são UTC. Um fuso real faria o teste de agendamento depender
 * do horário de verão — e o que a conversão faz de fato ganha teste próprio, com fuso
 * de verdade, em `importacao.test.ts`.
 */
export async function givenTenant(timezone = 'UTC'): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const clerkOrgId = `org_${suffix}`

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug: `teste-${suffix}`,
      name: 'Petshop Teste',
      clerkOrgId,
      status: 'ACTIVE',
      plan: 'PRO',
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 5,
      onboardingCompletedAt: new Date(),
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Atendente de Teste',
    },
  })

  await ownerPrisma.membership.create({
    data: {
      tenantId,
      userId: user.id,
      roleKey: 'TENANT_ADMIN',
      status: 'ACTIVE',
      // MOD-SEC-03: o mesmo prazo que o produto concede a quem vira administrador.
      mfaGraceUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  await ownerPrisma.tenantSettings.create({
    data: { tenantId, branding: {}, businessHours: {}, timezone },
  })

  /**
   * As versões vigentes dos termos (MOD-DOC-06).
   *
   * Sem elas **nenhum tutor entra**: o aceite grava a versão conferida contra
   * `term_versions`, e o tenant que nasce por INSERT não passou pelo provisionamento que
   * as semeia. É o mesmo que o fixture do MOD-TUTOR faz, e a razão de repeti-lo aqui é a
   * de sempre — o cenário é de quem importa, e a carga cria tutor de verdade.
   */
  await ownerPrisma.termVersion.createMany({
    data: TERM_KINDS.map((kind) => ({
      tenantId,
      kind,
      version: DEFAULT_TERM_VERSION,
      title: PLATFORM_TERM_SEEDS[kind].title,
      body: PLATFORM_TERM_SEEDS[kind].body,
    })),
  })

  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, clerkOrgId }
}

/** O administrador do tenant — o único papel que a matriz autoriza a importar. */
export function asAdmin(fixture: TenantFixture): Caller {
  return { clerkUserId: fixture.clerkUserId, clerkOrgId: fixture.clerkOrgId }
}

/**
 * Serviço com preço e duração em **todos** os portes.
 *
 * Preço por porte não é detalhe de cenário: sem a linha do porte do pet, o MOD-AGENDA
 * recusa o agendamento em vez de interpolar um valor — e é essa recusa que a carga
 * repassa ao relatório.
 */
export async function givenService(fixture: TenantFixture, name = 'Banho'): Promise<string> {
  const sizes = await ownerPrisma.size.findMany({ where: { tenantId: null } })

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        category: 'BATH',
        baseDurationMin: 60,
        pricing: {
          create: sizes.map((size) => ({
            tenantId: fixture.tenantId,
            sizeId: size.id,
            priceCents: BigInt(7000),
            durationMin: 60,
          })),
        },
      },
    })
    return service.id
  })
}

/** Jornada da semana inteira, das 08:00 às 18:00 no fuso do tenant. */
export const JORNADA_INTEIRA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startsAtMin: 480,
  endsAtMin: 1080,
}))

/** Dá jornada a quem a carga acabou de criar — a planilha não traz horário de trabalho. */
export async function givenSchedule(
  fixture: TenantFixture,
  professionalId: string,
  windows = JORNADA_INTEIRA,
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.professionalSchedule.createMany({
      data: windows.map((window) => ({
        tenantId: fixture.tenantId,
        professionalId,
        ...window,
      })),
    })
  })
}

/* ═══════════════════════════════════════════════════ O arquivo */

/**
 * Linhas → o corpo que a rota recebe.
 *
 * Data URL base64, como a tela manda: é o caminho real, e montar o CSV como texto puro
 * no teste pularia justamente a decodificação que o módulo existe para acertar.
 */
export function csv(linhas: string[][]): string {
  const texto = linhas.map((linha) => linha.join(';')).join('\n')
  return `data:text/csv;base64,${Buffer.from(texto, 'utf8').toString('base64')}`
}

/** O mesmo, em windows-1252 — o que o "CSV (separado por vírgulas)" do Excel produz. */
export function csvLatin1(linhas: string[][]): string {
  const texto = linhas.map((linha) => linha.join(';')).join('\n')
  return `data:text/csv;base64,${Buffer.from(texto, 'latin1').toString('base64')}`
}

/** `YYYY-MM-DD` de daqui a N dias, para a agenda futura. */
export function emDias(dias: number): string {
  const data = new Date(Date.now() + dias * 86_400_000)
  return data.toISOString().slice(0, 10)
}

/** `DD/MM/AAAA` do mesmo instante — o formato que a planilha traz. */
export function emDiasBR(dias: number): string {
  const [ano, mes, dia] = emDias(dias).split('-') as [string, string, string]
  return `${dia}/${mes}/${ano}`
}
