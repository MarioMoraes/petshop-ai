import Link from 'next/link'
import type { ReactNode } from 'react'
import { type MovementDay, type PetBirthday, type ProductResponse } from '@petshop/shared-types'
import {
  AlarmClockDuoIcon,
  CakeIcon,
  PackageIcon,
  PawPrintIcon,
  TrendingUpIcon,
  type IconTone,
} from '@/components/icons'
import type { HorarioDeHoje } from '@/lib/agenda-de-hoje'
import { formatQuantity } from '../estoque/format'
import { STATUS_LABELS } from '@/lib/agenda-dia'

/*
 * Os blocos do Início na Aurora (2026-11-04), na composição que o usuário aprovou em
 * imagem: quatro números no alto, a semana em barras e a agenda à direita, e embaixo
 * os aniversariantes e o estoque. Cada bloco só aparece com a permissão e o plano de
 * quem responde por ele — a grade fecha sozinha.
 */

const WEEKDAY = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

/** `YYYY-MM-DD` é data civil: o dia da semana sai da aritmética, sem fuso no caminho. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!
}

/** R$ 1,9k — o rótulo curto das barras. */
function brlCurto(cents: number): string {
  const reais = cents / 100
  if (reais >= 1000)
    return `R$ ${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`
  return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`
}

function CardHeadAurora({
  icon,
  tone,
  title,
  aside,
}: {
  icon: ReactNode
  tone: IconTone
  title: string
  aside?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className={`aurora-chip ${tone}`}>{icon}</span>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {aside && <span className="ml-auto text-[12.5px] font-medium text-subtle">{aside}</span>}
    </div>
  )
}

// ─── Os números do alto ──────────────────────────────────────────────────────

export function KpiCard({
  label,
  value,
  unit,
  prefix,
  pill,
  icon,
  tone,
  href,
  hero = false,
  spark,
}: {
  label: string
  value: string
  /** O sufixo menor ao lado do número ("%"). */
  unit?: string
  /** O prefixo menor ("R$"). */
  prefix?: string
  /** A etiqueta do canto: a variação ou a taxa. */
  pill?: string | null
  icon: ReactNode
  tone: IconTone
  href: Parameters<typeof Link>[0]['href']
  hero?: boolean
  /** Os sete totais da semana, para a linha do cartão escuro. */
  spark?: number[]
}) {
  return (
    <Link
      href={href}
      className={`${hero ? 'stat-hero' : 'card'} card-interactive relative flex min-h-[148px] flex-col overflow-hidden p-5`}
    >
      <span className={`aurora-chip ${tone} ${hero ? 'stat-hero-chip' : ''}`}>{icon}</span>
      {pill && (
        <span
          className={`absolute right-5 top-5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            hero ? 'bg-white/20 text-white' : 'bg-[rgb(15_164_122/0.14)] text-[#0f8a67]'
          }`}
        >
          {pill}
        </span>
      )}
      <p
        className={`mt-auto pt-4 text-[13px] font-medium ${hero ? 'text-white/70' : 'text-subtle'}`}
      >
        {label}
      </p>
      <p className="relative z-10 mt-1 text-[24px] font-light leading-none tracking-[-0.03em] tabular-nums">
        {prefix && <span className="mr-0.5 text-sm font-normal opacity-60">{prefix}</span>}
        {value}
        {unit && <span className="ml-0.5 text-sm font-normal opacity-60">{unit}</span>}
      </p>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </Link>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const w = 150
  const h = 60
  const pontos = values.map((v, i) => [(i / (values.length - 1)) * w, h - 6 - (v / max) * (h - 16)])
  const d = pontos
    .map(([x, y], i) => {
      if (i === 0) return `M${x} ${y}`
      const [px, py] = pontos[i - 1]!
      const cx = (px! + x!) / 2
      return `C${cx} ${py} ${cx} ${y} ${x} ${y}`
    })
    .join(' ')
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      className="pointer-events-none absolute bottom-0 right-0 h-[60px] w-[150px]"
    >
      <path d={d} fill="none" stroke="rgb(255 255 255 / 0.55)" strokeWidth="2" />
    </svg>
  )
}

// ─── A semana ────────────────────────────────────────────────────────────────

export function WeekChart({ days, today }: { days: MovementDay[]; today: string }) {
  const max = Math.max(1, ...days.map((d) => d.totalCents))
  return (
    <Link href="/agenda/dia" className="card card-interactive flex flex-col p-6 xl:col-span-8">
      <CardHeadAurora
        icon={<TrendingUpIcon />}
        tone="icon-money"
        title="Movimento da Semana"
        aside={
          <span className="flex gap-4">
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2 w-2 rounded-[3px] bg-[linear-gradient(180deg,var(--color-aurora-from),var(--color-aurora-to))]" />
              Hoje
            </span>
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2 w-2 rounded-[3px] bg-[rgb(123_92_255/0.15)]" />
              Outros dias
            </span>
          </span>
        }
      />
      <div className="flex h-[200px] flex-1 items-end gap-3 border-b border-line px-1 sm:gap-4 xl:h-auto">
        {days.map((day) => {
          const hoje = day.date === today
          return (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col items-center justify-end gap-2"
            >
              <span className="whitespace-nowrap text-[11.5px] font-semibold tabular-nums">
                {brlCurto(day.totalCents)}
              </span>
              <span
                className={`week-bar ${hoje ? 'week-bar-today' : ''}`}
                // Em px: dentro da coluna flex a porcentagem não tem altura de onde sair.
                style={{ height: `${Math.max(10, Math.round((day.totalCents / max) * 140))}px` }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex gap-3 px-1 pt-2.5 sm:gap-4">
        {days.map((day) => (
          <span
            key={day.date}
            className={`flex-1 text-center text-xs ${
              day.date === today ? 'font-bold text-ink' : 'font-medium text-subtle'
            }`}
          >
            {weekdayOf(day.date)}
          </span>
        ))}
      </div>
    </Link>
  )
}

// ─── A agenda de hoje ────────────────────────────────────────────────────────

/** O tom da etiqueta segue o estado, e não o assunto: é o que a recepção lê de longe. */
const TOM: Record<string, IconTone> = {
  PENDING: 'icon-brand',
  CONFIRMED: 'icon-system',
  CHECKED_IN: 'icon-people',
  IN_PROGRESS: 'icon-time',
  COMPLETED: 'icon-money',
}

/**
 * Rótulos de uma palavra: na coluna estreita da agenda, "Aguardando aprovação" cortava o
 * nome do pet, que é o que a recepção procura. O rótulo inteiro fica no `title`.
 */
const CURTO: Record<string, string> = {
  PENDING: 'Pedido',
  CONFIRMED: 'Confirmado',
  CHECKED_IN: 'Chegou',
  IN_PROGRESS: 'Atendendo',
  COMPLETED: 'Pronto',
}

export function AgendaCard({ horarios }: { horarios: HorarioDeHoje[] }) {
  return (
    <section className="card flex flex-col overflow-hidden px-5 py-6 xl:col-span-4 xl:row-span-2">
      <CardHeadAurora
        icon={<AlarmClockDuoIcon />}
        tone="icon-time"
        title="Agenda de Hoje"
        aside={
          // Noutra aba, como o atalho da Agenda: o mural fica aberto na TV da recepção
          // e o Início continua onde estava.
          <a href="/mural" target="_blank" rel="noopener" className="hover:text-ink">
            Ver Mural →
          </a>
        }
      />
      {horarios.length === 0 ? (
        <p className="py-6 text-sm text-subtle">Nenhum horário pela frente hoje.</p>
      ) : (
        <ul className="divide-y divide-line">
          {horarios.map((h) => (
            <li key={h.id} className="relative">
              {h.agora && (
                <span
                  aria-hidden="true"
                  className="absolute -left-5 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-[var(--color-aurora-to)]"
                />
              )}
              <Link
                href="/agenda/dia"
                className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 py-2.5"
              >
                <span className="text-[15px] font-semibold tabular-nums">{h.hora}</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="aurora-chip aurora-chip-pet icon-pet">
                    <PawPrintIcon />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{h.petName}</span>
                    <span className="block truncate text-xs text-subtle">
                      {h.servicos} · {h.profissional}
                    </span>
                  </span>
                </span>
                <span
                  title={STATUS_LABELS[h.status]}
                  className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    TOM[h.status] ?? 'icon-system'
                  } bg-[var(--icon-soft)] text-[var(--icon)]`}
                >
                  {CURTO[h.status] ?? STATUS_LABELS[h.status] ?? h.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── Aniversariantes ─────────────────────────────────────────────────────────

export function BirthdaysCard({ items, today }: { items: PetBirthday[]; today: string }) {
  const deHoje = items.filter((i) => i.date === today).length
  return (
    <section className="card px-6 py-5 xl:col-span-4">
      <CardHeadAurora
        icon={<CakeIcon />}
        tone="icon-health"
        title="Aniversariantes"
        aside={deHoje > 0 ? `${deHoje} hoje` : 'Próximos 7 dias'}
      />
      {items.length === 0 ? (
        <p className="text-sm text-subtle">Nenhum aniversário nos próximos 7 dias.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 3).map((item) => (
            <li key={item.petId}>
              <Link
                href={`/pets/${item.petId}`}
                className="flex items-center gap-3 py-2 text-[13.5px]"
              >
                <span className="aurora-chip aurora-chip-pet icon-pet">
                  <PawPrintIcon />
                </span>
                <span className="min-w-0 truncate">
                  {item.name} faz {item.turning} {item.turning === 1 ? 'ano' : 'anos'}
                </span>
                <b className="ml-auto font-semibold">
                  {item.date === today ? 'Hoje' : weekdayOf(item.date)}
                </b>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── Estoque em alerta ───────────────────────────────────────────────────────

export function StockCard({
  low,
  expiring,
}: {
  low: ProductResponse[]
  expiring: ProductResponse[]
}) {
  const linhas = [
    ...low.map((p) => ({ p, tag: 'Baixo', tone: 'icon-brand' as IconTone })),
    ...expiring
      .filter((p) => !low.some((l) => l.id === p.id))
      .map((p) => ({ p, tag: 'Vence', tone: 'icon-pet' as IconTone })),
  ]
  return (
    <section className="card px-6 py-5 xl:col-span-4">
      <CardHeadAurora
        icon={<PackageIcon />}
        tone="icon-system"
        title="Estoque em Alerta"
        aside={`${linhas.length} ${linhas.length === 1 ? 'item' : 'itens'}`}
      />
      {linhas.length === 0 ? (
        <p className="text-sm text-subtle">Nenhum produto em alerta.</p>
      ) : (
        <ul className="divide-y divide-line">
          {linhas.slice(0, 3).map(({ p, tag, tone }) => (
            <li key={p.id}>
              <Link
                href={`/estoque/${p.id}`}
                className="flex items-center gap-3 py-2 text-[13.5px]"
              >
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tone} bg-[var(--icon-soft)] text-[var(--icon)]`}
                >
                  {tag}
                </span>
                <span className="min-w-0 truncate">{p.name}</span>
                <b className="ml-auto whitespace-nowrap font-semibold tabular-nums">
                  {formatQuantity(p.quantityOnHand, p.unit)}
                </b>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
