import { WEEKDAY_LABELS, WEEKDAYS, type BusinessHours, type Weekday } from '@petshop/shared-types'

/**
 * O horário renderizado como o petshop o escreveria: dias agrupados.
 *
 * "Seg a Sex, 8h–18h; Sáb, 8h–13h; Dom, fechado" — e não sete linhas idênticas. É o
 * mesmo `business_hours` que a agenda usa para saber quando há vaga (AC-01 de
 * MOD-SITE-06): **não existe uma segunda cópia do horário para manter**.
 */

const SHORT_LABELS: Record<Weekday, string> = {
  monday: 'Seg',
  tuesday: 'Ter',
  wednesday: 'Qua',
  thursday: 'Qui',
  friday: 'Sex',
  saturday: 'Sáb',
  sunday: 'Dom',
}

export interface HoursGroup {
  /** "Seg a Sex" ou "Sábado". */
  days: string
  /** "8h–18h" ou "fechado". */
  hours: string
}

function humanTime(time: string): string {
  const [hour, minute] = time.split(':')
  return minute === '00' ? `${Number(hour)}h` : `${Number(hour)}h${minute}`
}

function describe(day: BusinessHours[Weekday]): string {
  return day.closed ? 'fechado' : `${humanTime(day.opensAt)}–${humanTime(day.closesAt)}`
}

export function groupBusinessHours(hours: BusinessHours): HoursGroup[] {
  const groups: { first: Weekday; last: Weekday; hours: string }[] = []

  for (const weekday of WEEKDAYS) {
    const description = describe(hours[weekday])
    const previous = groups.at(-1)

    // Só agrupa dias **consecutivos** com o mesmo horário: "Seg a Sex" é legível;
    // "Seg, Qua e Sex" ficaria pior agrupado do que listado.
    if (previous && previous.hours === description) {
      previous.last = weekday
    } else {
      groups.push({ first: weekday, last: weekday, hours: description })
    }
  }

  return groups.map((group) => ({
    days:
      group.first === group.last
        ? WEEKDAY_LABELS[group.first]
        : `${SHORT_LABELS[group.first]} a ${SHORT_LABELS[group.last]}`,
    hours: group.hours,
  }))
}
