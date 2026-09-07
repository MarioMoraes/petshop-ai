import type { Prisma } from '@petshop/db'
import type { ServiceCategory } from '@petshop/shared-types'

/**
 * Tradução linha → resposta.
 *
 * Síncrono de propósito: nenhum mapper faz I/O. O que precisa de consulta extra
 * (contagem de agendamentos futuros, por exemplo) entra depois, num passo próprio —
 * mapper que busca no banco vira N+1 sem ninguém perceber.
 */

type ServiceRow = Prisma.ServiceGetPayload<{
  include: { pricing: true; professionals: true }
}>

type ProfessionalRow = Prisma.ProfessionalGetPayload<{
  include: { services: true; schedules: true }
}>

/**
 * As respostas são declaradas, não inferidas.
 *
 * Sem a anotação o TypeScript tenta nomear os tipos gerados do Prisma pelo caminho
 * dentro de `node_modules` e recusa emitir (TS2742). Declarar também congela o
 * contrato: mudar uma coluna deixa de mudar a API por acidente.
 */
export interface ServicePricingResponse {
  sizeId: string
  priceCents: number
  durationMin: number
}

export interface ServiceResponse {
  id: string
  name: string
  category: ServiceCategory
  description: string | null
  baseDurationMin: number
  requiresVet: boolean
  active: boolean
  showOnSite: boolean
  pricing: ServicePricingResponse[]
  professionalIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ScheduleWindowResponse {
  weekday: number
  startsAtMin: number
  endsAtMin: number
}

export interface ProfessionalResponse {
  id: string
  userId: string | null
  displayName: string
  roleKey: string
  maxConcurrentPets: number
  color: string | null
  active: boolean
  crmv: string | null
  crmvState: string | null
  serviceIds: string[]
  schedule: ScheduleWindowResponse[]
  createdAt: string
  updatedAt: string
}

export interface CalendarBlockResponse {
  id: string
  professionalId: string | null
  startsAt: string
  endsAt: string
  reason: string | null
  scope: 'PROFESSIONAL' | 'TENANT'
  createdAt: string
}

export function toServiceResponse(row: ServiceRow): ServiceResponse {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    baseDurationMin: row.baseDurationMin,
    requiresVet: row.requiresVet,
    active: row.active,
    showOnSite: row.showOnSite,
    // `price_cents` é BIGINT no banco (convenção de dinheiro do PRD 05) e chega como
    // `bigint`. O JSON não sabe serializá-lo, e os valores aqui — centavos de um
    // banho — cabem folgadamente em Number.
    pricing: row.pricing
      .map((item) => ({
        sizeId: item.sizeId,
        priceCents: Number(item.priceCents),
        durationMin: item.durationMin,
      }))
      .sort((a, b) => a.sizeId.localeCompare(b.sizeId)),
    professionalIds: row.professionals.map((link) => link.professionalId).sort(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toProfessionalResponse(row: ProfessionalRow): ProfessionalResponse {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    roleKey: row.roleKey,
    maxConcurrentPets: row.maxConcurrentPets,
    color: row.color,
    active: row.active,
    crmv: row.crmv,
    crmvState: row.crmvState,
    serviceIds: row.services.map((link) => link.serviceId).sort(),
    schedule: row.schedules
      .map((window) => ({
        weekday: window.weekday,
        startsAtMin: window.startsAtMin,
        endsAtMin: window.endsAtMin,
      }))
      // Ordenada para a UI desenhar a semana sem reordenar: dia, depois hora.
      .sort((a, b) => a.weekday - b.weekday || a.startsAtMin - b.startsAtMin),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toCalendarBlockResponse(row: {
  id: string
  professionalId: string | null
  startsAt: Date
  endsAt: Date
  reason: string | null
  createdAt: Date
}): CalendarBlockResponse {
  return {
    id: row.id,
    professionalId: row.professionalId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    /** Sem `professionalId` é feriado: bloqueia o tenant inteiro (AC-03). */
    scope: row.professionalId ? ('PROFESSIONAL' as const) : ('TENANT' as const),
    createdAt: row.createdAt.toISOString(),
  }
}
