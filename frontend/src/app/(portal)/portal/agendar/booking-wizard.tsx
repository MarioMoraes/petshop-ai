'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatBRL, type PortalPetSummary, type PortalSlot } from '@petshop/shared-types'
import { Alert, Card, Choice, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, CalendarIcon, CheckIcon, PawPrintIcon } from '@/components/icons'
import {
  carregarHorarios,
  carregarServicos,
  confirmarAgendamento,
  type ActionFailure,
} from './actions'

/**
 * Marcar horário, no celular (MOD-PORTAL-05).
 *
 * **Uma coluna que cresce, e não um wizard com Avançar e Voltar.** A tela do Admin tem
 * cinco passos porque a recepção agenda dezenas por dia e precisa corrigir o passo 2 sem
 * perder o 4. O tutor faz isto quatro vezes por ano, com o polegar: cada resposta abre a
 * pergunta seguinte logo abaixo, e trocar de ideia é rolar para cima e tocar de novo.
 *
 * Cada pergunta depende da anterior **no servidor**, não só na tela: o preço é do porte
 * do pet, a grade é da duração dos serviços escolhidos, e a antecedência mínima já vem
 * descontada da lista de horários. Nada aqui é calculado do lado do cliente — o que o
 * tutor vê é o que o POST vai aceitar.
 */

interface Servico {
  id: string
  name: string
  description: string | null
  priceCents: number
  durationMin: number
}

export function BookingWizard({
  pets,
  tenantName,
}: {
  pets: PortalPetSummary[]
  tenantName: string
}) {
  const router = useRouter()
  const [petId, setPetId] = useState<string | null>(pets.length === 1 ? pets[0]!.id : null)
  const [servicos, setServicos] = useState<Servico[]>([])
  const [escolhidos, setEscolhidos] = useState<string[]>([])
  const [dia, setDia] = useState('')
  const [horarios, setHorarios] = useState<PortalSlot[]>([])
  const [proximo, setProximo] = useState<string | null>(null)
  const [fuso, setFuso] = useState('America/Sao_Paulo')
  const [escolhido, setEscolhido] = useState<PortalSlot | null>(null)
  const [falha, setFalha] = useState<ActionFailure | null>(null)
  const [reconhecerAlertas, setReconhecerAlertas] = useState(false)
  const [carregando, startTransition] = useTransition()

  /**
   * Cada busca leva sua marca, e só a última vale.
   *
   * Trocar de dia duas vezes seguidas num 4G ruim deixa duas buscas no ar; sem isto a
   * que chegasse por último venceria, ainda que fosse a resposta do dia anterior. É o
   * mesmo horário fantasma que o assistente do Admin já teve.
   */
  const buscaId = useRef(0)

  const pet = pets.find((candidato) => candidato.id === petId) ?? null
  const selecionados = servicos.filter((servico) => escolhidos.includes(servico.id))
  const total = selecionados.reduce((soma, servico) => soma + servico.priceCents, 0)

  // Os serviços dependem do pet: o preço é do porte dele.
  useEffect(() => {
    if (!petId) return
    setServicos([])
    setEscolhidos([])
    setHorarios([])
    setEscolhido(null)
    setFalha(null)

    startTransition(async () => {
      const resultado = await carregarServicos(petId)
      if (!resultado.ok) {
        setFalha(resultado)
        return
      }
      setServicos(resultado.services)
    })
  }, [petId])

  /**
   * A grade depende do conjunto de serviços e do dia.
   *
   * A chave é a lista **em texto**, e não o array: um array novo a cada render dispararia
   * a busca em loop. `escolhidos` é lido dentro do efeito e sai da lista de dependências
   * de propósito — é o mesmo valor que a chave já representa.
   */
  const chaveServicos = escolhidos.join(',')

  useEffect(() => {
    if (!petId || escolhidos.length === 0 || dia === '') return
    const marca = ++buscaId.current
    setEscolhido(null)
    setFalha(null)

    startTransition(async () => {
      const resultado = await carregarHorarios({ petId, serviceIds: escolhidos, date: dia })
      if (marca !== buscaId.current) return

      if (!resultado.ok) {
        setFalha(resultado)
        setHorarios([])
        return
      }
      setHorarios(resultado.slots)
      setProximo(resultado.nextAvailable)
      setFuso(resultado.timezone)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petId, chaveServicos, dia])

  function alternar(servicoId: string) {
    setEscolhidos((antes) =>
      antes.includes(servicoId)
        ? antes.filter((id) => id !== servicoId)
        : [...antes, servicoId],
    )
  }

  function confirmar() {
    if (!petId || !escolhido) return
    setFalha(null)

    startTransition(async () => {
      const resultado = await confirmarAgendamento({
        petId,
        serviceIds: escolhidos,
        startsAt: escolhido.startsAt,
        professionalId: escolhido.professionalId,
        ...(reconhecerAlertas ? { acknowledgedAlerts: true } : {}),
      })

      if (!resultado.ok) {
        setFalha(resultado)
        // RN-09: o alerta clínico é um "tem certeza?", e a segunda tentativa passa. O
        // botão precisa mudar de texto, e é este estado que o muda.
        if (resultado.code === 'ERR_AGENDA_009') setReconhecerAlertas(true)
        return
      }

      router.push('/portal/agendamentos')
      router.refresh()
    })
  }

  return (
    <>
      {pets.length > 1 && (
        <Card>
          <SectionHead
            icon={<PawPrintIcon />}
            tone="icon-pet"
            eyebrow="Passo 1"
            title="Para quem é"
          />
          <div className="mt-4 flex flex-col gap-2">
            {pets.map((candidato) => (
              <button
                key={candidato.id}
                type="button"
                onClick={() => setPetId(candidato.id)}
                aria-pressed={candidato.id === petId}
                className={`option w-full text-left ${candidato.id === petId ? 'border-focus' : ''}`}
              >
                <span className="min-w-0">
                  <span className="option-text block">{candidato.name}</span>
                  <span className="hint mt-0.5 block">
                    {[candidato.species, candidato.breed].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {candidato.id === petId && (
                  <span className="text-accent shrink-0">
                    <CheckIcon />
                  </span>
                )}
              </button>
            ))}
          </div>
        </Card>
      )}

      {pet && (
        <Card>
          <SectionHead
            icon={<PawPrintIcon />}
            tone="icon-pet"
            eyebrow={pets.length > 1 ? 'Passo 2' : 'Passo 1'}
            title="O que o pet vai fazer"
            description={`Os preços são os do porte do ${pet.name}.`}
          />

          {servicos.length === 0 && !carregando && (
            <p className="hint mt-4">
              O {tenantName} ainda não tem serviços disponíveis para agendar pelo site.
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {servicos.map((servico) => (
              <Choice
                key={servico.id}
                checked={escolhidos.includes(servico.id)}
                onChange={() => alternar(servico.id)}
                label={
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{servico.name}</span>
                    <span className="shrink-0 font-medium">{formatBRL(servico.priceCents)}</span>
                  </span>
                }
                {...(servico.description ? { description: servico.description } : {})}
              />
            ))}
          </div>

          {selecionados.length > 1 && (
            <p className="hint mt-3">
              Total: <strong className="text-ink">{formatBRL(total)}</strong>
            </p>
          )}
        </Card>
      )}

      {escolhidos.length > 0 && (
        <Card>
          <SectionHead
            icon={<CalendarIcon />}
            tone="icon-time"
            eyebrow={pets.length > 1 ? 'Passo 3' : 'Passo 2'}
            title="Que dia"
          />
          <input
            type="date"
            className="field mt-4"
            value={dia}
            min={hojeISO()}
            onChange={(evento) => setDia(evento.target.value)}
            aria-label="Dia do agendamento"
          />

          {dia !== '' && (
            <div className="mt-4">
              {horarios.length === 0 ? (
                <p className="hint">
                  {carregando
                    ? 'Procurando horários…'
                    : proximo
                      ? `Não há horário neste dia. O próximo disponível é ${dataHoraLonga(proximo, fuso)}.`
                      : 'Não há horário disponível neste dia.'}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {horarios.map((slot) => (
                    <button
                      key={`${slot.startsAt}-${slot.professionalId}`}
                      type="button"
                      onClick={() => setEscolhido(slot)}
                      aria-pressed={escolhido?.startsAt === slot.startsAt}
                      className={`btn ${
                        escolhido?.startsAt === slot.startsAt ? 'btn-primary' : 'btn-ghost'
                      } h-10 px-4`}
                    >
                      {hora(slot.startsAt, fuso)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {falha && (
        <Alert
          tone={falha.code === 'ERR_AGENDA_009' ? 'accent' : 'danger'}
          icon={<AlertTriangleIcon />}
          title={falha.code === 'ERR_AGENDA_009' ? 'Atenção no atendimento' : 'Não deu para marcar'}
        >
          {falha.message}
        </Alert>
      )}

      {escolhido && (
        <Card>
          <SectionHead
            icon={<CheckIcon />}
            tone="icon-brand"
            eyebrow="Confirmação"
            title="Tudo certo?"
          />
          <div className="mt-4 flex flex-col gap-1 text-sm">
            <p>
              <strong>{pet?.name}</strong> · {selecionados.map((s) => s.name).join(', ')}
            </p>
            <p className="text-muted">
              {dataHoraLonga(escolhido.startsAt, fuso)} com {escolhido.professionalName}
            </p>
            <p className="mt-2 text-base font-medium">{formatBRL(total)}</p>
          </div>

          <button
            type="button"
            className="btn btn-primary mt-5 w-full"
            onClick={confirmar}
            disabled={carregando}
          >
            {carregando
              ? 'Marcando…'
              : reconhecerAlertas
                ? 'Confirmar mesmo assim'
                : 'Confirmar horário'}
          </button>
        </Card>
      )}
    </>
  )
}

/** Hoje no fuso de quem está olhando — é o piso do seletor de data. */
function hojeISO(): string {
  const agora = new Date()
  const local = new Date(agora.getTime() - agora.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function hora(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}

/** RN-19: a hora é a do petshop, não a do aparelho de quem está olhando. */
function dataHoraLonga(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
