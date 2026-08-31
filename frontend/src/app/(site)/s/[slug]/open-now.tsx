'use client'

import { useEffect, useState } from 'react'
import type { BusinessHours, Weekday } from '@petshop/shared-types'

/**
 * O selo "aberto agora" (AC-03 de MOD-SITE-06).
 *
 * **Calculado no cliente, e é por isso que este componente existe.** A página fica em
 * cache por dez minutos; um selo renderizado no servidor diria "aberto" para quem
 * chega às 18h05 num dia que fecha às 18h. O horário e o fuso vêm embarcados na
 * página, e a conta acontece no browser de quem está lendo.
 *
 * Nasce sem selo nenhum e o preenche depois da hidratação: um estado inicial
 * "fechado" apareceria por um instante em todo carregamento, inclusive às dez da
 * manhã de uma terça.
 */

const ORDER: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

function minutesNow(timezone: string): { weekday: Weekday; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date())

    const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lookup.weekday ?? '')
    if (index < 0) return null

    return {
      weekday: ORDER[index] as Weekday,
      minutes: Number(lookup.hour) * 60 + Number(lookup.minute),
    }
  } catch {
    // Fuso desconhecido no browser do visitante: melhor não mostrar selo nenhum do
    // que mostrar um errado.
    return null
  }
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

export function OpenNow({
  businessHours,
  timezone,
}: {
  businessHours: BusinessHours
  timezone: string
}) {
  const [open, setOpen] = useState<boolean | null>(null)

  useEffect(() => {
    function check() {
      const now = minutesNow(timezone)
      if (!now) return setOpen(null)

      const today = businessHours[now.weekday]
      setOpen(
        !today.closed &&
          now.minutes >= toMinutes(today.opensAt) &&
          now.minutes < toMinutes(today.closesAt),
      )
    }

    check()
    // Um minuto: o selo precisa virar sozinho para quem deixou a aba aberta na hora
    // de fechar — é justamente na virada que ele erraria.
    const timer = setInterval(check, 60_000)
    return () => clearInterval(timer)
  }, [businessHours, timezone])

  if (open === null) return null

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium"
      style={{
        backgroundColor: open ? '#e6f4ec' : '#f3f4f7',
        color: open ? '#1f7a4d' : '#4b4d52',
      }}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: open ? '#1f7a4d' : '#86888d' }}
      />
      {open ? 'Aberto agora' : 'Fechado agora'}
    </span>
  )
}
