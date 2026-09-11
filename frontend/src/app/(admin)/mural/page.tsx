import type { Metadata, Viewport } from 'next'
import { redirect } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import {
  todayIn,
  zonedDayRange,
  type CalendarBlockResponse,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import { carregarMe, serverApi } from '@/lib/api'
import { MuralBoard } from './mural-board'
import { MuralVazio } from './mural-vazio'

/**
 * O Mural do dia (a Agenda do Dia sozinha, em outra aba).
 *
 * A Agenda do Dia divide a página com o menu lateral, a faixa de datas, as abas e os
 * números do dia — e o que sobra para a linha do tempo é uma janela de umas seis horas
 * num expediente de dez. A recepção rola para achar a tarde, rola de volta para achar a
 * manhã, e nunca vê o dia inteiro de uma vez.
 *
 * Aqui a tela é só o dia. Sem moldura, a escala deixa de ser fixa e passa a ser uma
 * divisão (`escalaDoMural`): a faixa desenhada se ajusta à altura da janela e o
 * expediente entra sem rolagem. É a única razão de esta rota existir — o resto é
 * consequência, inclusive o fundo escuro, que não é tema alternativo do Admin e sim o
 * material de uma tela que fica ligada num monitor o dia inteiro.
 *
 * **Só lê.** Chegou, concluir, taxi e cancelar continuam na ficha da Agenda do Dia, e a
 * gaveta daqui leva para lá. Uma segunda superfície de escrita sobre o mesmo
 * agendamento seria uma segunda chance de divergir da máquina de estado, em troca de
 * nada — quem opera está na outra aba, com o teclado.
 *
 * A moldura não vem de um `layout.tsx` próprio: bastava um para a rota herdar a
 * exigência de `loading.tsx` de `loading-boundaries.test.ts`, e o esqueleto de uma tela
 * que ocupa a janela inteira seria uma tela preta piscando a cada troca de dia.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Mural do dia — PetShop AI',
}

/**
 * A barra do navegador acompanha o fundo do Mural.
 *
 * No celular e no Safari a faixa do endereço herda esta cor; sem ela, uma tarja clara
 * fica pendurada no topo de uma tela que é escura de ponta a ponta.
 */
export const viewport: Viewport = {
  themeColor: '#0d0e11',
}

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function MuralPage({ searchParams }: PageProps) {
  const params = await searchParams

  /*
   * O gate de onboarding é o mesmo do `layout.tsx` da agenda, repetido aqui porque esta
   * rota não passa por ele. Sem serviços semeados nem jornada definida, o Mural mostra
   * um dia vazio que não é o dia vazio de verdade.
   */
  const me = await carregarMe()
  if (!me.currentTenant?.onboardingCompletedAt) redirect('/onboarding')

  // "Hoje" é o dia do estabelecimento e não o do servidor — a mesma conta da Agenda do
  // Dia, pelo mesmo motivo: em UTC um petshop no Acre vira o dia às 19h.
  const settings = await serverApi()
    .getSettings()
    .catch(() => null)
  const timezone = settings?.timezone ?? 'America/Sao_Paulo'
  const hoje = todayIn(timezone)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : hoje

  const { from, to } = zonedDayRange(date, timezone)

  // Nenhuma das chamadas de apoio derruba o Mural: sem leva-e-traz ele continua sendo a
  // agenda do dia, que é o que se veio ver. Só `getDayView` tem estado de erro próprio.
  const [view, rides, blocks] = await Promise.all([
    serverApi()
      .getDayView(date)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
    serverApi()
      .listTaxiRides({ date, limit: 100 })
      .then((page) => page.items)
      .catch((): TaxiRideResponse[] => []),
    serverApi()
      .listCalendarBlocks({ from: from.toISOString(), to: to.toISOString() })
      .catch((): CalendarBlockResponse[] => []),
  ])

  if (view instanceof ApiError) {
    return (
      <MuralVazio
        date={date}
        titulo={view.status === 403 ? 'Sem acesso à agenda geral' : 'A agenda não respondeu'}
        descricao={
          view.status === 403
            ? 'Seu perfil só vê a própria agenda, não a visão do dia com todos os profissionais.'
            : 'O serviço de agendamentos está indisponível agora. Recarregue em instantes.'
        }
      />
    )
  }

  const taxiRides: Record<string, TaxiRideResponse[]> = {}
  for (const ride of rides) {
    ;(taxiRides[ride.appointmentId] ??= []).push(ride)
  }

  return (
    <MuralBoard
      view={view}
      date={date}
      today={hoje}
      tenantName={me.currentTenant.name}
      taxiRides={taxiRides}
      blocks={blocks}
    />
  )
}
