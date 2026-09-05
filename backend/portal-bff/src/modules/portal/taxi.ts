import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AppError,
  TAXI_LEG_LABELS,
  TAXI_SILENT_CANCEL_REASONS,
  taxiStatusTutorText,
  type PortalBookingTaxi,
  type PortalTaxiOffer,
  type PortalTaxiRide,
  type TaxiLeg,
  type TaxiRideStatus,
} from '@petshop/shared-types'
import { invalid } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { openCipher } from './crypto.js'
import { getTaxiPort, type TaxiCaller, type TaxiLegRequest } from './taxi-port.js'

/**
 * MOD-PORTAL-07 — o leva-e-traz pedido junto do agendamento.
 *
 * Três coisas moram aqui, e vale saber quem manda em cada uma:
 *
 * - **a oferta** (`readTaxiOffer`) é meio banco, meio domínio: o endereço primário do
 *   tutor sai da tabela, e o preço daquele CEP sai de `GET /v1/taxi/quote`, que existe
 *   desde o MOD-TAXI exatamente para responder "quanto custa buscar aqui?" sem criar
 *   corrida nenhuma;
 * - **a janela** (`planLegs`) é conta pura, e a mesma que o painel do Admin faz: a
 *   coleta termina quando o atendimento começa, a entrega começa quando ele termina.
 *   São os limites que `assertCoherentWindow` confere do outro lado;
 * - **a vaga** (`assertCapacity`) é a única regra que o Portal tem e o balcão não. Está
 *   explicada em `assertCapacity`, porque a diferença não é óbvia.
 *
 * A criação da corrida em si é inteira do taxidog-service, pela `taxi-port`.
 */

/** Quanto tempo o Portal considera "cedo demais" para prometer uma coleta. */
const MIN_PICKUP_LEAD_MS = 15 * 60_000

/** Teto de horários alternativos que o 409 de van cheia oferece (AC-04). */
const MAX_ALTERNATIVES = 3

/** Quantos horários do dia vale a pena sondar antes de desistir de achar alternativa. */
const MAX_PROBES = 6

export interface TaxiSettingsSnapshot {
  enabled: boolean
  configured: boolean
  windowMinutes: number
}

export interface TutorAddressSnapshot {
  label: string
  zipCode: string
}

// ─── A oferta ────────────────────────────────────────────────────────────────

export async function readTaxiSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<TaxiSettingsSnapshot> {
  const settings = await tx.taxiSettings.findUnique({
    where: { tenantId },
    select: { enabled: true, taxiServiceId: true, defaultWindowMinutes: true },
  })

  return {
    enabled: settings?.enabled ?? false,
    // Sem o serviço de catálogo que ancora a cobrança, o domínio recusaria com
    // ERR_TAXI_010 na hora de criar (RN-05). Melhor a caixa nem aparecer.
    configured: Boolean(settings?.taxiServiceId),
    windowMinutes: settings?.defaultWindowMinutes ?? 60,
  }
}

/**
 * O endereço para onde o motorista iria.
 *
 * Decifrado aqui, como o resto da ficha do tutor no Portal: o RN-16 proíbe **cópia
 * local** de dado pessoal, não a leitura, e o texto morre no fim da requisição. É o
 * endereço do próprio dono da conta, exibido inteiro de propósito — a última chance de
 * alguém notar que a família se mudou é antes de confirmar.
 */
export async function readPrimaryAddress(
  tx: TenantTransaction,
  tenantId: string,
  tutorId: string,
): Promise<TutorAddressSnapshot | null> {
  const address = await tx.tutorAddress.findFirst({
    where: { tutorId, isPrimary: true },
    select: {
      zipCode: true,
      streetEncrypted: true,
      numberEncrypted: true,
      district: true,
      city: true,
    },
  })
  if (!address) return null

  const cipher = await openCipher(tx, tenantId)
  const street = cipher.decrypt(address.streetEncrypted)
  const number = cipher.decrypt(address.numberEncrypted)

  return {
    label: `${street}, ${number} — ${address.district}, ${address.city}`,
    zipCode: address.zipCode,
  }
}

/**
 * AC-02 — o preço antes de pedir.
 *
 * **Divergência consciente do AC-03: a indisponibilidade desce como 200, não 422.**
 * "Este endereço está fora da área" é a resposta certa a uma pergunta legítima, e não
 * uma falha do pedido — o tutor perguntou se dá, e a resposta é não. Um 422 obrigaria a
 * tela a tratar o caminho normal de leitura como erro para desenhar uma caixa
 * desabilitada, e o wizard inteiro mostraria "não deu para marcar" a quem só abriu a
 * tela. O 422 do AC-03 continua existindo onde ele tem sentido: no domínio, se alguém
 * pedir a corrida assim mesmo.
 */
export async function readTaxiOffer(
  caller: TaxiCaller,
  tutorId: string,
): Promise<PortalTaxiOffer> {
  const { settings, address } = await withTenant(caller.tenantId, async (tx) => ({
    settings: await readTaxiSettings(tx, caller.tenantId),
    address: await readPrimaryAddress(tx, caller.tenantId, tutorId),
  }))

  const vazia = (
    reason: PortalTaxiOffer['reason'],
    message: string,
  ): PortalTaxiOffer => ({
    available: false,
    reason,
    message,
    address: address ?? null,
    priceCentsPerLeg: null,
    windowMinutes: settings.windowMinutes,
  })

  if (!settings.enabled) {
    return vazia('DISABLED', 'Este estabelecimento não faz leva-e-traz.')
  }
  if (!settings.configured) {
    return vazia(
      'NOT_CONFIGURED',
      'O leva-e-traz ainda não está disponível por aqui. Fale com o estabelecimento.',
    )
  }
  if (!address) {
    return vazia(
      'NO_ADDRESS',
      'Não temos o seu endereço cadastrado. Fale com o estabelecimento para incluir e poder pedir o leva-e-traz.',
    )
  }

  try {
    const quote = await getTaxiPort().quote(caller, address.zipCode)
    return {
      available: true,
      reason: null,
      message: null,
      address,
      priceCentsPerLeg: quote.priceCents,
      windowMinutes: settings.windowMinutes,
    }
  } catch (error) {
    // RN-18 do MOD-TAXI: recusar o CEP é opt-in do petshop. Quando ele recusa, a zona
    // não cobre o endereço e não há preço a mostrar.
    if (error instanceof AppError && error.code === 'ERR_TAXI_011') {
      return vazia(
        'OUT_OF_AREA',
        'O seu endereço está fora da área atendida pelo leva-e-traz.',
      )
    }

    logger.warn({ err: error }, 'falha ao cotar o leva-e-traz do Portal')
    return vazia(
      'UNAVAILABLE',
      'Não foi possível consultar o leva-e-traz agora. Você pode marcar o horário e falar com o estabelecimento sobre o transporte.',
    )
  }
}

// ─── A janela ────────────────────────────────────────────────────────────────

export interface PlannedLegs {
  legs: TaxiLegRequest[]
}

/**
 * As janelas das pernas, a partir do atendimento.
 *
 * A coleta **termina** quando o banho começa e a entrega **começa** quando ele termina —
 * são exatamente os limites que o `assertCoherentWindow` do taxidog-service confere
 * (AC-03 de MOD-TAXI-01). Calculá-las aqui, e não deixar o tutor escolher, é o que faz o
 * pedido caber sempre: uma janela digitada por quem não vê a agenda seria recusada
 * metade das vezes, e o tutor não teria como saber por quê.
 *
 * O tamanho é `default_window_minutes` do petshop — a mesma configuração que a recepção
 * usa no painel da Agenda do Dia.
 */
export function planLegs(
  appointment: { startsAt: Date; endsAt: Date },
  windowMinutes: number,
  choice: PortalBookingTaxi,
): TaxiLegRequest[] {
  const legs: TaxiLegRequest[] = []
  const span = windowMinutes * 60_000

  if (choice.pickup) {
    legs.push({
      leg: 'PICKUP',
      windowStartsAt: new Date(appointment.startsAt.getTime() - span).toISOString(),
      windowEndsAt: appointment.startsAt.toISOString(),
    })
  }
  if (choice.dropoff) {
    legs.push({
      leg: 'DROPOFF',
      windowStartsAt: appointment.endsAt.toISOString(),
      windowEndsAt: new Date(appointment.endsAt.getTime() + span).toISOString(),
    })
  }

  return legs
}

// ─── A vaga ──────────────────────────────────────────────────────────────────

/**
 * AC-04 — a van cheia recusa **antes** de existir agendamento.
 *
 * **Esta é a única regra que o Portal tem e o balcão não, e a diferença é deliberada.**
 * No taxidog-service, corrida sem motorista nasce em `REQUESTED` e não checa capacidade
 * — `REQUESTED` não ocupa a van de ninguém, e a recepção que cria a corrida sabe que vai
 * escalar alguém depois, remanejando o dia se precisar. O tutor não sabe disso e não
 * remaneja nada: para ele, "pedido aceito" é uma promessa. Enfileirar um pedido sem vaga
 * seria prometer o que a operação não prometeu, e o AC-04 diz isso com todas as letras.
 *
 * A checagem acontece **antes** de o agendamento ser criado, e é por isso que ela recebe
 * a janela calculada a partir da duração somada dos serviços em vez do `ends_at` real.
 * A alternativa — criar o agendamento e recusar a corrida depois — deixaria o tutor com
 * um banho marcado num horário que ele não tem como alcançar, e ainda por cima um
 * cancelamento para fazer.
 */
export async function assertCapacity(
  caller: TaxiCaller,
  legs: TaxiLegRequest[],
  alternatives: () => Promise<string[]>,
): Promise<void> {
  const now = Date.now()
  const pickup = legs.find((leg) => leg.leg === 'PICKUP')

  if (pickup && new Date(pickup.windowStartsAt).getTime() < now + MIN_PICKUP_LEAD_MS) {
    throw invalid(
      'Não dá tempo de organizar a coleta para este horário. Escolha um horário mais tarde ou marque sem o leva-e-traz.',
    )
  }

  const cheias: TaxiLeg[] = []
  for (const leg of legs) {
    if (!(await hasRoom(caller, leg))) cheias.push(leg.leg)
  }
  if (cheias.length === 0) return

  const quais = cheias.map((leg) => TAXI_LEG_LABELS[leg].toLowerCase()).join(' e ')

  /**
   * `ERR_TAXI_007` e não um código do Portal: o §5 manda o código do domínio atravessar,
   * porque é ele que responde "por que isso falhou" para quem depura meses depois. O que
   * o BFF reescreve é a frase — "a van de Carlos já está com 4 pets" é a linguagem do
   * balcão, e o tutor não conhece o Carlos.
   */
  throw new AppError(
    'ERR_TAXI_007',
    `Não temos vaga no leva-e-traz para ${quais} neste horário. Escolha outro horário ou marque sem o transporte.`,
    undefined,
    { alternativeStartsAt: await alternatives() },
  )
}

async function hasRoom(caller: TaxiCaller, leg: TaxiLegRequest): Promise<boolean> {
  const drivers = await getTaxiPort().availableDrivers(caller, {
    startsAt: leg.windowStartsAt,
    endsAt: leg.windowEndsAt,
  })
  return drivers.some((driver) => driver.remaining > 0)
}

/**
 * Os horários do mesmo dia em que o leva-e-traz ainda cabe (AC-04).
 *
 * Sonda um horário de cada vez, com teto, e **só no caminho da recusa**: é trabalho que
 * não vale a pena fazer nos 99% dos pedidos que passam de primeira. `MAX_PROBES` existe
 * porque um dia cheio tem trinta vagas na grade, e trinta consultas para montar uma
 * lista de três seria pior do que não oferecer alternativa nenhuma.
 *
 * Devolve o início do **atendimento**, não da janela da corrida: é o que a tela já
 * mostra em botões, e é nele que o tutor toca.
 */
export async function findAlternativeSlots(
  caller: TaxiCaller,
  candidates: { startsAt: string; endsAt: string }[],
  windowMinutes: number,
  choice: PortalBookingTaxi,
): Promise<string[]> {
  const encontrados: string[] = []

  for (const candidate of candidates.slice(0, MAX_PROBES)) {
    if (encontrados.length >= MAX_ALTERNATIVES) break

    const legs = planLegs(
      { startsAt: new Date(candidate.startsAt), endsAt: new Date(candidate.endsAt) },
      windowMinutes,
      choice,
    )

    try {
      let cabe = true
      for (const leg of legs) {
        if (!(await hasRoom(caller, leg))) {
          cabe = false
          break
        }
      }
      if (cabe) encontrados.push(candidate.startsAt)
    } catch (error) {
      // A alternativa é cortesia. Se o taxidog não responde, a recusa segue sem ela —
      // trocar um 409 explicado por um 502 seria piorar a resposta que já temos.
      logger.warn({ err: error }, 'falha ao sondar horário alternativo do leva-e-traz')
      break
    }
  }

  return encontrados
}

// ─── A leitura ───────────────────────────────────────────────────────────────

interface RideRow {
  id: string
  appointmentId: string
  leg: string
  status: string
  windowStartsAt: Date
  windowEndsAt: Date
  priceCents: bigint
  cancelReason: string | null
}

/**
 * AC-05 — as corridas dos agendamentos, para o tutor acompanhar.
 *
 * Leitura direta do banco, recortada por `tutorId`, como o resto da fatia 2: não há
 * regra a aplicar, só um recorte a escolher. Nem endereço nem motorista entram no
 * `select` — o endereço está cifrado e é o mesmo que o tutor cadastrou, e o nome de quem
 * dirige é dado de um trabalhador que não muda nada do que o tutor faz a seguir.
 *
 * **A corrida cancelada em cascata não aparece.** Ela existe porque o agendamento
 * morreu, e o tutor já está olhando para o agendamento cancelado; repetir o fato como
 * "corrida cancelada" faria parecer que houve dois problemas. É a mesma lista de motivos
 * silenciosos que o MOD-CRM usa para não mandar dois avisos.
 */
export async function readRidesByAppointment(
  tx: TenantTransaction,
  tutorId: string,
  appointmentIds: string[],
): Promise<Map<string, PortalTaxiRide[]>> {
  const porAgendamento = new Map<string, PortalTaxiRide[]>()
  if (appointmentIds.length === 0) return porAgendamento

  const rides = (await tx.taxiRide.findMany({
    where: { tutorId, appointmentId: { in: appointmentIds } },
    orderBy: [{ windowStartsAt: 'asc' }],
    select: {
      id: true,
      appointmentId: true,
      leg: true,
      status: true,
      windowStartsAt: true,
      windowEndsAt: true,
      priceCents: true,
      cancelReason: true,
    },
  })) as RideRow[]

  for (const ride of rides) {
    if (
      ride.status === 'CANCELLED' &&
      ride.cancelReason !== null &&
      (TAXI_SILENT_CANCEL_REASONS as readonly string[]).includes(ride.cancelReason)
    ) {
      continue
    }

    const lista = porAgendamento.get(ride.appointmentId) ?? []
    lista.push(toPortalRide(ride))
    porAgendamento.set(ride.appointmentId, lista)
  }

  return porAgendamento
}

export function toPortalRide(ride: {
  id: string
  leg: string
  status: string
  windowStartsAt: Date
  windowEndsAt: Date
  priceCents: bigint
}): PortalTaxiRide {
  const leg = ride.leg as TaxiLeg
  const status = ride.status as TaxiRideStatus

  return {
    id: ride.id,
    leg,
    legLabel: TAXI_LEG_LABELS[leg],
    status,
    statusText: taxiStatusTutorText(leg, status),
    windowStartsAt: ride.windowStartsAt.toISOString(),
    windowEndsAt: ride.windowEndsAt.toISOString(),
    priceCents: Number(ride.priceCents),
  }
}
