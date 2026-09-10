'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  formatBRL,
  type PortalPetSummary,
  type PortalSlot,
  type PortalTaxiOffer,
} from '@petshop/shared-types'
import { Alert, Button, Card, Choice, SectionHead } from '@/components/ui'
import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckIcon,
  PawPrintIcon,
  VanIcon,
} from '@/components/icons'
import { ButtonLink } from '@/components/links'
import {
  carregarHorarios,
  carregarServicos,
  carregarTaxi,
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
  taxiEnabled,
}: {
  pets: PortalPetSummary[]
  tenantName: string
  /** `features.taxiEnabled` do contexto: sem isso a oferta nem chega a ser perguntada. */
  taxiEnabled: boolean
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
  const [oferta, setOferta] = useState<PortalTaxiOffer | null>(null)
  const [levar, setLevar] = useState(false)
  const [trazer, setTrazer] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
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
  const servicosCents = selecionados.reduce((soma, servico) => soma + servico.priceCents, 0)

  const pernas = (levar ? 1 : 0) + (trazer ? 1 : 0)
  const taxiCents = (oferta?.priceCentsPerLeg ?? 0) * pernas
  const total = servicosCents + taxiCents

  /**
   * O cartão do leva-e-traz aparece por dois motivos e some por um.
   *
   * Aparece quando dá para pedir, e aparece quando **não** dá por um motivo do próprio
   * tutor — endereço faltando ou fora da área —, porque essa é a informação que ele
   * precisa para resolver. Some quando o petshop simplesmente não faz leva-e-traz: aí
   * não é uma negativa, é um serviço que não existe, e anunciá-lo para negar em seguida
   * só ocuparia a tela.
   */
  const mostrarTaxi =
    oferta !== null && oferta.reason !== 'DISABLED' && oferta.reason !== 'NOT_CONFIGURED'

  /**
   * A numeração dos passos é montada, e não escrita à mão.
   *
   * O cartão do pet só existe para quem tem mais de um, e o do leva-e-traz só para quem
   * pode pedir — dois condicionais que já bastariam para a tela dizer "Passo 3" duas
   * vezes na mesma rolagem.
   */
  const passos = [
    ...(pets.length > 1 ? ['pet'] : []),
    'servicos',
    ...(mostrarTaxi ? ['taxi'] : []),
    'dia',
  ]
  const passo = (chave: string) => `Passo ${passos.indexOf(chave) + 1}`

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
   * A oferta de leva-e-traz é pedida uma vez, e não a cada escolha.
   *
   * O preço é do CEP do endereço primário do tutor: nem o pet, nem os serviços, nem o
   * horário o mudam. Refazer a pergunta a cada toque só somaria latência à tela.
   */
  useEffect(() => {
    if (!taxiEnabled) return

    startTransition(async () => {
      const resultado = await carregarTaxi()
      if (resultado.ok) setOferta(resultado)
    })
  }, [taxiEnabled])

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
      antes.includes(servicoId) ? antes.filter((id) => id !== servicoId) : [...antes, servicoId],
    )
  }

  /**
   * Confirma o pedido.
   *
   * `comTaxi` existe para o botão "marcar sem o leva-e-traz" da recusa por falta de vaga
   * (AC-04): ele reenvia o mesmo pedido sem o transporte, sem obrigar o tutor a rolar
   * para cima e desmarcar duas caixas. Perder o banho por causa do transporte é o pior
   * desfecho possível, e um toque é o que separa o tutor dele.
   */
  function confirmar(comTaxi = true) {
    if (!petId || !escolhido) return
    setFalha(null)
    setAviso(null)

    const pedirTaxi = comTaxi && mostrarTaxi && (levar || trazer)

    startTransition(async () => {
      const resultado = await confirmarAgendamento({
        petId,
        serviceIds: escolhidos,
        startsAt: escolhido.startsAt,
        professionalId: escolhido.professionalId,
        ...(reconhecerAlertas ? { acknowledgedAlerts: true } : {}),
        ...(pedirTaxi ? { taxi: { pickup: levar, dropoff: trazer } } : {}),
      })

      if (!resultado.ok) {
        setFalha(resultado)
        // RN-09: o alerta clínico é um "tem certeza?", e a segunda tentativa passa. O
        // botão precisa mudar de texto, e é este estado que o muda.
        if (resultado.code === 'ERR_AGENDA_009') setReconhecerAlertas(true)
        return
      }

      /**
       * O agendamento nasceu e o leva-e-traz não (AC-03).
       *
       * A tela **para aqui** em vez de navegar: o aviso é a única notícia que o tutor vai
       * receber sobre o transporte, e passar direto para a lista o faria descobrir depois,
       * na porta de casa, que ninguém vem buscar.
       */
      if (resultado.taxiWarning) {
        setAviso(resultado.taxiWarning)
        router.refresh()
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
            eyebrow={passo('servicos')}
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
              Total: <strong className="text-ink">{formatBRL(servicosCents)}</strong>
            </p>
          )}
        </Card>
      )}

      {escolhidos.length > 0 && mostrarTaxi && oferta && (
        <Card>
          <SectionHead
            icon={<VanIcon />}
            tone="icon-time"
            eyebrow={passo('taxi')}
            title="Leva-e-traz"
            description={oferta.available ? 'Buscamos e devolvemos o seu pet em casa.' : undefined}
          />

          {oferta.available ? (
            <>
              <div className="mt-4 flex flex-col gap-2">
                <Choice
                  checked={levar}
                  onChange={setLevar}
                  label={
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">Buscar o pet em casa</span>
                      <span className="shrink-0 font-medium">
                        {formatBRL(oferta.priceCentsPerLeg ?? 0)}
                      </span>
                    </span>
                  }
                />
                <Choice
                  checked={trazer}
                  onChange={setTrazer}
                  label={
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">Devolver o pet em casa</span>
                      <span className="shrink-0 font-medium">
                        {formatBRL(oferta.priceCentsPerLeg ?? 0)}
                      </span>
                    </span>
                  }
                />
              </div>

              {/*
                O endereço aparece antes de virar corrida: é para lá que o motorista vai,
                e esta é a última tela em que alguém pode notar que a família se mudou.
              */}
              {oferta.address && (
                <p className="hint mt-3">
                  {pernas > 0 ? 'Vamos até ' : 'No endereço '}
                  <strong className="text-ink">{oferta.address.label}</strong>.
                </p>
              )}

              {pernas > 0 && (
                <p className="hint mt-1">
                  A janela é de até {oferta.windowMinutes} minutos antes ou depois do atendimento.
                  Avisamos quando o motorista sair.
                </p>
              )}
            </>
          ) : (
            <p className="hint mt-4">{oferta.message}</p>
          )}
        </Card>
      )}

      {escolhidos.length > 0 && (
        <Card>
          <SectionHead
            icon={<CalendarIcon />}
            tone="icon-time"
            eyebrow={passo('dia')}
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
                    <Button
                      key={`${slot.startsAt}-${slot.professionalId}`}
                      type="button"
                      variant={escolhido?.startsAt === slot.startsAt ? 'primary' : 'ghost'}
                      className="h-10 px-4"
                      onClick={() => setEscolhido(slot)}
                      aria-pressed={escolhido?.startsAt === slot.startsAt}
                    >
                      {hora(slot.startsAt, fuso)}
                    </Button>
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
          title={
            falha.code === 'ERR_AGENDA_009'
              ? 'Atenção no atendimento'
              : falha.code === 'ERR_TAXI_007'
                ? 'Sem vaga no leva-e-traz'
                : 'Não deu para marcar'
          }
        >
          {falha.message}

          {/*
            AC-04: a recusa aponta a saída. Os horários vêm do servidor, que sondou a
            van em cada um deles — a tela não adivinha nenhum.
          */}
          {falha.alternativeStartsAt && falha.alternativeStartsAt.length > 0 && (
            <span className="mt-3 flex flex-wrap gap-2">
              {falha.alternativeStartsAt.map((instante) => (
                <Button
                  key={instante}
                  type="button"
                  variant="ghost"
                  className="h-9 px-3"
                  onClick={() => {
                    const alvo = horarios.find((slot) => slot.startsAt === instante)
                    if (alvo) setEscolhido(alvo)
                    setFalha(null)
                  }}
                >
                  {hora(instante, fuso)}
                </Button>
              ))}
            </span>
          )}

          {falha.code === 'ERR_TAXI_007' && (
            <span className="mt-3 block">
              <Button
                type="button"
                variant="ghost"
                className="h-9"
                onClick={() => confirmar(false)}
                busy={carregando}
                busyLabel="Marcando…"
              >
                Marcar sem o leva-e-traz
              </Button>
            </span>
          )}
        </Alert>
      )}

      {/*
        O agendamento existe e o transporte não. O tutor não segue para a lista sozinho:
        este aviso é a única notícia que ele vai ter sobre o leva-e-traz.
      */}
      {aviso && (
        <Alert
          tone="accent"
          icon={<VanIcon />}
          title="Horário marcado, transporte não"
          role="status"
        >
          {aviso}
          <span className="mt-3 block">
            <ButtonLink href="/portal/agendamentos" className="h-9">
              Ver meus agendamentos
            </ButtonLink>
          </span>
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

            {/*
              AC-02: o valor da corrida somado ao do serviço, **antes** da confirmação.
              Discriminado e não embutido no total, porque o tutor precisa poder decidir
              tirar só o transporte.
            */}
            {pernas > 0 && oferta?.priceCentsPerLeg !== null && (
              <p className="text-muted">
                Leva-e-traz: {[levar && 'buscar', trazer && 'devolver'].filter(Boolean).join(' e ')}
                {' · '}
                {formatBRL(taxiCents)}
              </p>
            )}

            <p className="mt-2 text-base font-medium">{formatBRL(total)}</p>
          </div>

          <Button
            type="button"
            className="mt-5 w-full"
            onClick={() => confirmar()}
            busy={carregando}
            busyLabel="Marcando…'
              : reconhecerAlertas
                ? 'Confirmar mesmo assim"
          >
            Confirmar horário
          </Button>
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
