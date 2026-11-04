import type { DayView } from '@petshop/shared-types'
import { horaDe, minutosNoFuso } from './agenda-dia'

/**
 * A agenda de hoje no Início (Aurora, 2026-11-04): os horários do dia numa lista só,
 * na ordem do relógio, sem a divisão por profissional que o quadro da Agenda tem.
 *
 * Cancelado e remarcado saem, porque não vão acontecer. O que já passou sai também,
 * **menos** o que ainda está em andamento ou esperando — um pet que chegou às 9h e
 * continua no banho às 10h é exatamente o que a recepção precisa ver.
 */
export interface HorarioDeHoje {
  id: string
  hora: string
  petName: string
  servicos: string
  profissional: string
  status: string
  /** O que está acontecendo agora: chegou ou em atendimento. */
  agora: boolean
}

const FORA_DA_LISTA = new Set(['CANCELLED', 'RESCHEDULED'])
const EM_CURSO = new Set(['CHECKED_IN', 'IN_PROGRESS'])
const ENCERRADO = new Set(['COMPLETED', 'NO_SHOW'])

export function agendaDeHoje(view: DayView, agoraMin: number, limite = 5): HorarioDeHoje[] {
  return view.columns
    .flatMap((coluna) =>
      coluna.appointments.map((a) => ({ a, profissional: coluna.professionalName })),
    )
    .filter(({ a }) => !FORA_DA_LISTA.has(a.status))
    .map(({ a, profissional }) => ({
      inicio: minutosNoFuso(a.startsAt, view.timezone),
      fim: minutosNoFuso(a.endsAt, view.timezone),
      a,
      profissional,
    }))
    .filter(({ fim, a }) => EM_CURSO.has(a.status) || (!ENCERRADO.has(a.status) && fim > agoraMin))
    .sort((x, y) => x.inicio - y.inicio)
    .slice(0, limite)
    .map(({ inicio, a, profissional }) => ({
      id: a.id,
      hora: horaDe(inicio),
      petName: a.petName,
      servicos: a.services.join(', '),
      profissional,
      status: a.status,
      agora: EM_CURSO.has(a.status),
    }))
}
