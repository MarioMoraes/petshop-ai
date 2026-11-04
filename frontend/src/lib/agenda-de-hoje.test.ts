import { describe, expect, it } from 'vitest'
import type { DayView } from '@petshop/shared-types'
import { agendaDeHoje } from './agenda-de-hoje'

const TZ = 'America/Sao_Paulo'
// 13:00Z = 10:00 em São Paulo.
const iso = (h: number, m = 0) =>
  `2026-11-04T${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`

function ag(id: string, h: number, status: string, petName = id) {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    startsAt: iso(h),
    endsAt: iso(h, 45),
    status,
    petId: '00000000-0000-4000-8000-000000000001',
    petName,
    tutorId: '00000000-0000-4000-8000-000000000002',
    services: ['Banho', 'Tosa'],
    totalCents: 0,
    alerts: [],
    checkinAt: null,
  }
}

const view = {
  date: '2026-11-04',
  timezone: TZ,
  columns: [
    {
      professionalId: 'a',
      professionalName: 'Ana',
      color: null,
      maxConcurrentPets: 1,
      shifts: [],
      absent: false,
      absenceReason: null,
      occupancyPercent: 0,
      appointments: [
        ag('1', 8, 'COMPLETED'),
        ag('2', 11, 'CONFIRMED', 'Thor'),
        ag('3', 9, 'IN_PROGRESS', 'Mel'),
      ],
    },
    {
      professionalId: 'b',
      professionalName: 'Bruno',
      color: null,
      maxConcurrentPets: 1,
      shifts: [],
      absent: false,
      absenceReason: null,
      occupancyPercent: 0,
      appointments: [
        ag('4', 10, 'CANCELLED'),
        ag('5', 10, 'CONFIRMED', 'Luna'),
        ag('6', 7, 'CONFIRMED', 'Velho'),
      ],
    },
  ],
} as unknown as DayView

describe('agendaDeHoje', () => {
  it('junta os profissionais na ordem do relógio, no fuso do estabelecimento', () => {
    const lista = agendaDeHoje(view, 10 * 60)
    expect(lista.map((h) => [h.hora, h.petName, h.profissional])).toEqual([
      ['09:00', 'Mel', 'Ana'],
      ['10:00', 'Luna', 'Bruno'],
      ['11:00', 'Thor', 'Ana'],
    ])
  })

  it('tira cancelado, concluído e o que já acabou — mas mantém o que está em curso', () => {
    const ids = agendaDeHoje(view, 10 * 60).map((h) => h.petName)
    expect(ids).not.toContain('Velho')
    expect(ids).toContain('Mel')
    expect(agendaDeHoje(view, 10 * 60).find((h) => h.petName === 'Mel')?.agora).toBe(true)
  })

  it('respeita o limite', () => {
    expect(agendaDeHoje(view, 0, 2)).toHaveLength(2)
  })
})
