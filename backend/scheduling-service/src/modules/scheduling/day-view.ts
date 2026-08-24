import { withTenant } from '@petshop/db'
import type { ActorContext } from '../catalog/actor.js'

/**
 * Visão do dia (MOD-AGENDA-09).
 *
 * É a tela mais aberta do produto e tem SLO de 300ms, então tudo aqui é lote: quatro
 * consultas para o dia inteiro, não uma por profissional nem uma por agendamento.
 *
 * A decisão que mais afeta a tela está no AC-02: **profissional sem jornada no dia
 * continua aparecendo**, marcado como ausente. Uma coluna que some faz a equipe achar
 * que o sistema perdeu a pessoa, e alguém vai ligar para o suporte perguntando cadê a
 * Ana.
 */

export interface DayColumn {
  professionalId: string
  professionalName: string
  color: string | null
  maxConcurrentPets: number
  /** Faixas de trabalho do dia, em minutos desde a meia-noite. */
  shifts: { startsAtMin: number; endsAtMin: number }[]
  /** AC-02: sem jornada e sem bloqueio, a coluna aparece vazia e marcada. */
  absent: boolean
  absenceReason: string | null
  appointments: DayAppointment[]
  /** Horas ocupadas ÷ horas de jornada. É o número que diz se falta cliente. */
  occupancyPercent: number
}

export interface DayAppointment {
  id: string
  startsAt: string
  endsAt: string
  status: string
  petId: string
  petName: string
  tutorId: string
  services: string[]
  totalCents: number
  /** Agregado do prontuário — a equipe vê antes de encostar no pet (RN-09). */
  alerts: { severity: string; label: string }[]
  checkinAt: string | null
}

const TEMPERAMENT_SEVERITY: Record<string, string | null> = {
  AGGRESSIVE: 'CRITICAL',
  REACTIVE: 'HIGH',
  FEARFUL: 'MEDIUM',
  ANXIOUS: 'LOW',
  DOCILE: null,
  UNKNOWN: null,
}

const TEMPERAMENT_LABELS: Record<string, string> = {
  AGGRESSIVE: 'Agressivo',
  REACTIVE: 'Reativo',
  FEARFUL: 'Medroso',
  ANXIOUS: 'Ansioso',
}

/**
 * O dia inteiro, coluna por profissional.
 *
 * `date` chega como `YYYY-MM-DD` e o dia é delimitado no **fuso do tenant** (RN-19):
 * "hoje" em Manaus não é "hoje" em São Paulo, e usar UTC deslocaria a agenda em
 * algumas horas na madrugada.
 */
export async function getDayView(
  actor: ActorContext,
  date: string,
  timezone: string,
): Promise<{ date: string; timezone: string; columns: DayColumn[] }> {
  const { start, end } = dayBounds(date, timezone)
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()

  const columns = await withTenant(actor.tenantId, async (tx) => {
    const professionals = await tx.professional.findMany({
      where: { active: true, deletedAt: null },
      include: { schedules: { where: { weekday } } },
      orderBy: { displayName: 'asc' },
    })
    if (professionals.length === 0) return []

    const ids = professionals.map((p) => p.id)

    const [appointments, blocks] = await Promise.all([
      tx.appointment.findMany({
        where: {
          professionalId: { in: ids },
          startsAt: { lt: end },
          endsAt: { gt: start },
          status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
        },
        include: { items: true, pet: { select: { id: true, name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
      tx.calendarBlock.findMany({
        where: {
          startsAt: { lt: end },
          endsAt: { gt: start },
          OR: [{ professionalId: { in: ids } }, { professionalId: null }],
        },
      }),
    ])

    // Alertas em lote: uma consulta por tabela para todos os pets do dia, não três
    // por agendamento.
    const petIds = [...new Set(appointments.map((a) => a.petId))]
    const [allergies, temperaments, medicalAlerts] = await Promise.all([
      tx.allergy.findMany({
        where: { petId: { in: petIds }, active: true },
        select: { petId: true, label: true, severity: true },
      }),
      tx.temperament.findMany({
        where: { petId: { in: petIds }, isCurrent: true },
        select: { petId: true, classification: true },
      }),
      tx.medicalAlert.findMany({
        where: { petId: { in: petIds }, active: true },
        // O rótulo do alerta médico é `condition`; alergia usa `label`. A projeção
        // uniformiza para a tela, que só quer "o que é" e "quão grave".
        select: { petId: true, condition: true, severity: true },
      }),
    ])

    const alertsByPet = new Map<string, { severity: string; label: string }[]>()
    function push(petId: string, alert: { severity: string; label: string }) {
      alertsByPet.set(petId, [...(alertsByPet.get(petId) ?? []), alert])
    }
    for (const row of allergies) push(row.petId, { severity: row.severity, label: row.label })
    for (const row of medicalAlerts) {
      push(row.petId, { severity: row.severity, label: row.condition })
    }
    for (const row of temperaments) {
      const severity = TEMPERAMENT_SEVERITY[row.classification]
      if (severity) {
        push(row.petId, {
          severity,
          label: TEMPERAMENT_LABELS[row.classification] ?? row.classification,
        })
      }
    }

    return professionals.map((professional) => {
      const shifts = professional.schedules.map((s) => ({
        startsAtMin: s.startsAtMin,
        endsAtMin: s.endsAtMin,
      }))
      const mine = appointments.filter((a) => a.professionalId === professional.id)

      const blocking = blocks.find(
        (b) => b.professionalId === null || b.professionalId === professional.id,
      )
      // O bloqueio explica a ausência; a falta de jornada só a constata.
      const absent = shifts.length === 0 || blocking !== undefined
      const absenceReason = blocking
        ? (blocking.reason ?? 'Bloqueio na agenda')
        : shifts.length === 0
          ? 'Sem jornada neste dia'
          : null

      const shiftMinutes = shifts.reduce((sum, s) => sum + (s.endsAtMin - s.startsAtMin), 0)
      const bookedMinutes = mine.reduce(
        (sum, a) => sum + (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000,
        0,
      )

      return {
        professionalId: professional.id,
        professionalName: professional.displayName,
        color: professional.color,
        maxConcurrentPets: professional.maxConcurrentPets,
        shifts,
        absent,
        absenceReason,
        appointments: mine.map((a) => ({
          id: a.id,
          startsAt: a.startsAt.toISOString(),
          endsAt: a.endsAt.toISOString(),
          status: a.status,
          petId: a.petId,
          petName: a.pet.name,
          tutorId: a.tutorId,
          services: a.items.map((item) => item.label),
          totalCents: Number(a.totalCents),
          alerts: (alertsByPet.get(a.petId) ?? []).sort(
            (x, y) => severityRank(y.severity) - severityRank(x.severity),
          ),
          checkinAt: a.checkinAt?.toISOString() ?? null,
        })),
        // Capacidade paralela multiplica a jornada disponível: quem atende 3 pets ao
        // mesmo tempo tem três vezes mais minutos vendáveis no mesmo turno.
        occupancyPercent:
          shiftMinutes === 0
            ? 0
            : Math.round(
                (bookedMinutes / (shiftMinutes * professional.maxConcurrentPets)) * 100,
              ),
      }
    })
  })

  return { date, timezone, columns }
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0
}

/**
 * O início e o fim do dia no fuso do tenant.
 *
 * Calculado por diferença de offset, e não por aritmética de UTC: o horário de verão
 * muda a duração real do dia, e somar 24h daria o instante errado exatamente na
 * madrugada em que a agenda mais precisa acertar.
 */
export function dayBounds(date: string, timezone: string): { start: Date; end: Date } {
  const start = zonedMidnight(date, timezone)
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const end = zonedMidnight(next.toISOString().slice(0, 10), timezone)
  return { start, end }
}

function zonedMidnight(date: string, timezone: string): Date {
  const naive = new Date(`${date}T00:00:00Z`)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(naive).map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  // A diferença entre o instante formatado no fuso e o instante original é o offset.
  return new Date(naive.getTime() + (naive.getTime() - asUtc))
}
