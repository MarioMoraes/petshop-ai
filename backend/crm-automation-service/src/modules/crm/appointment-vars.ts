import type { TenantTransaction } from '@petshop/db'
import { DEFAULT_TIMEZONE } from '@petshop/shared-types'

/**
 * As variáveis de um agendamento, prontas para o template.
 *
 * Duas escolhas que o AC-05 de MOD-CRM-05 força:
 *
 * - **`pets.lista` é uma lista.** Um tutor com três pets no mesmo horário recebe
 *   **uma** mensagem com os três nomes. Três mensagens seguidas para o mesmo número é
 *   o comportamento que faz o cliente bloquear o petshop.
 * - **Data e hora já vêm formatadas no fuso do tenant.** O template é escrito por
 *   quem atende no balcão; pedir que ele saiba de fuso seria pedir demais, e um
 *   horário de banho exibido em UTC é um cliente que chega três horas atrasado.
 */

export interface AppointmentVariables {
  tutorId: string
  petId: string
  variables: Record<string, string>
}

interface AppointmentRow {
  id: string
  petId: string
  tutorId: string
  startsAt: Date
  pet: { name: string }
  professional: { displayName: string }
  items: { label: string }[]
}

export async function loadAppointmentVariables(
  tx: TenantTransaction,
  appointmentId: string,
): Promise<AppointmentVariables | null> {
  const appointment = (await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      petId: true,
      tutorId: true,
      startsAt: true,
      pet: { select: { name: true } },
      professional: { select: { displayName: true } },
      items: { select: { label: true } },
    },
  })) as AppointmentRow | null

  if (!appointment) return null

  const settings = await tx.tenantSettings.findFirst({ select: { timezone: true } })
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE

  // Todos os pets do mesmo tutor no mesmo horário entram na mesma mensagem.
  const siblings = await tx.appointment.findMany({
    where: {
      tutorId: appointment.tutorId,
      startsAt: appointment.startsAt,
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
    },
    select: { pet: { select: { name: true } } },
  })

  const names = [...new Set(siblings.map((row) => row.pet.name))]
  const petList = names.length > 0 ? formatList(names) : appointment.pet.name

  return {
    tutorId: appointment.tutorId,
    petId: appointment.petId,
    variables: {
      'pets.lista': petList,
      'agendamento.data': formatDate(appointment.startsAt, timezone),
      'agendamento.hora': formatTime(appointment.startsAt, timezone),
      'agendamento.servico': appointment.items.map((item) => item.label).join(', '),
      'agendamento.profissional': appointment.professional.displayName,
    },
  }
}

/** "Thor", "Thor e Mel", "Thor, Mel e Bidu" — como se escreve, não como se itera. */
function formatList(names: string[]): string {
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`
}

function formatDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(instant)
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant)
}
