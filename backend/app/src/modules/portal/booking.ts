import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AppError,
  BOOKABLE_SERVICE_CATEGORIES,
  formatBRL,
  zonedDate,
  zonedDayRange,
  type PortalAvailabilityQuery,
  type PortalAvailabilityResponse,
  type PortalBookableService,
  type PortalBookingInput,
  type PortalBookingServicesResponse,
  type PortalBookingTaxi,
  type PortalTaxiRide,
} from '@petshop/shared-types'
import { forbidden, invalid, notFound } from './errors.js'
import { logger } from '../../shared/logger.js'
import { assertOwnsPet } from './pets.js'
import { getSchedulingPort, type SchedulingCaller } from './scheduling-port.js'
import {
  assertCapacity,
  findAlternativeSlots,
  planLegs,
  readRidesByAppointment,
  readTaxiOffer,
  readTaxiSettings,
  toPortalRide,
} from './taxi.js'
import { getTaxiPort } from './taxi-port.js'

/**
 * MOD-PORTAL-05 — marcar horário.
 *
 * O módulo tem três passos e cada um tem um dono diferente, o que é a coisa mais
 * importante a entender aqui:
 *
 * - **o cardápio** é leitura de catálogo, e o BFF a faz direto no banco, como o resto
 *   da fatia 2;
 * - **a grade de horários** é do scheduling-service, e o BFF só a repassa — recalcular
 *   disponibilidade aqui criaria uma segunda agenda (AC-01: "a mesma consulta que a
 *   recepção faz, sem cópia de lógica");
 * - **a criação** é do scheduling-service inteira, com os gates, a transação
 *   serializável e o evento. O BFF prova a posse antes, e traduz o erro depois.
 *
 * O que sobra de regra própria do Portal é uma só, e está em `assertOnlineBooking`:
 * agendamento online desligado é 403 mesmo com a rota chamada direto (AC-07).
 */

/** Estados que ainda ocupam lugar — usados para reconhecer o duplo toque. */
const LIVE_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] as const

export interface BookingSettings {
  timezone: string
  minNoticeHours: number
}

/**
 * AC-07 — o agendamento online desligado tranca **esta** porta, não o Portal.
 *
 * A checagem é de servidor e não de tela: o PRD pede 403 mesmo se a rota for chamada
 * direto, porque esconder o botão não é desligar nada.
 */
export async function assertOnlineBooking(
  tx: TenantTransaction,
  tenantId: string,
): Promise<BookingSettings> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: {
      timezone: true,
      portalEnabled: true,
      onlineBookingEnabled: true,
      minBookingNoticeHours: true,
    },
  })

  if (!settings?.portalEnabled) {
    throw forbidden('O Portal está indisponível neste estabelecimento no momento.')
  }
  if (!settings.onlineBookingEnabled) {
    throw forbidden(
      'Este estabelecimento não recebe agendamentos pelo site. Fale com a equipe para marcar.',
    )
  }

  /**
   * A triagem (`online_booking_requires_approval`) **não** é lida aqui: quem decide se
   * o agendamento nasce `PENDING` é o scheduling-service, e a tela sabe do gate pelo
   * `/portal/v1/me`. Ler a mesma chave num terceiro lugar só criaria a chance de os
   * três discordarem.
   */
  return { timezone: settings.timezone, minNoticeHours: settings.minBookingNoticeHours }
}

// ─── O cardápio ──────────────────────────────────────────────────────────────

/**
 * AC-02 — os serviços agendáveis **com o preço deste pet**.
 *
 * O preço sai de `service_pricing` pelo porte do animal, que é a mesma fonte que a
 * criação vai congelar no item. Serviço sem linha de preço para aquele porte não entra
 * na lista: o `resolveItems` do domínio o recusaria com 422, e oferecer o que será
 * recusado é levar o tutor até o fim de um caminho sem saída.
 *
 * `TAXI` fica de fora por `BOOKABLE_SERVICE_CATEGORIES` — corrida se pede junto do
 * agendamento (fatia 4), nunca como se fosse um banho.
 */
export async function listBookableServices(
  tenantId: string,
  tutorId: string,
  petId: string,
): Promise<PortalBookingServicesResponse> {
  return withTenant(tenantId, async (tx) => {
    await assertOnlineBooking(tx, tenantId)
    const pet = await assertOwnsPet(tx, tutorId, petId)

    // Pet falecido ou fora do estabelecimento não se agenda — e o domínio recusaria
    // com `ERR_AGENDA_010`. Aqui a lista simplesmente não existe.
    if (pet.status !== 'ACTIVE' && pet.status !== 'INACTIVE') {
      throw notFound('Este pet não está disponível para agendamento')
    }

    const services = await tx.service.findMany({
      where: {
        active: true,
        deletedAt: null,
        category: { in: [...BOOKABLE_SERVICE_CATEGORIES] },
        // Só quem tem alguém habilitado a executar: serviço sem profissional nunca
        // teria horário, e a tela ficaria oferecendo um dia vazio atrás do outro.
        professionals: { some: { professional: { active: true, deletedAt: null } } },
      },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        pricing: {
          where: { sizeId: pet.sizeId },
          select: { priceCents: true, durationMin: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const bookable: PortalBookableService[] = []
    for (const service of services) {
      const price = service.pricing[0]
      if (!price) continue
      bookable.push({
        id: service.id,
        name: service.name,
        description: service.description,
        category: service.category,
        priceCents: Number(price.priceCents),
        durationMin: price.durationMin,
      })
    }

    return { petName: pet.name, services: bookable }
  })
}

// ─── A grade ─────────────────────────────────────────────────────────────────

/**
 * AC-01 — os horários reais, filtrados pela antecedência mínima.
 *
 * O filtro do RN-07 acontece **aqui**, e não na tela: o domínio só aplica a regra na
 * criação, e uma grade que oferece 10:30 para depois recusá-la com 422 é a definição de
 * armadilha. O número vai junto na resposta para a tela poder dizer por que a manhã
 * começou mais tarde.
 */
export async function readAvailability(
  caller: SchedulingCaller,
  tutorId: string,
  query: PortalAvailabilityQuery,
): Promise<PortalAvailabilityResponse> {
  const settings = await withTenant(caller.tenantId, async (tx) => {
    const found = await assertOnlineBooking(tx, caller.tenantId)
    await assertOwnsPet(tx, tutorId, query.petId)
    return found
  })

  const day = zonedDayRange(query.date, settings.timezone)
  const response = await getSchedulingPort().availability(caller, {
    petId: query.petId,
    serviceIds: query.serviceIds,
    from: day.from.toISOString(),
    to: day.to.toISOString(),
  })

  const earliest = new Date(Date.now() + settings.minNoticeHours * 60 * 60_000)
  const slots = response.slots.filter((slot) => new Date(slot.startsAt) >= earliest)

  /**
   * `nextAvailable` também passa pela antecedência.
   *
   * O domínio o calcula sem saber do Portal — é o próximo horário livre **para o
   * balcão**. Apontar para ele numa tela cujo POST o recusaria seria mandar o tutor
   * bater numa porta fechada, que é o oposto do AC-04.
   */
  const next =
    response.nextAvailable && new Date(response.nextAvailable) >= earliest
      ? response.nextAvailable
      : null

  return {
    slots: slots.map((slot) => ({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      professionalId: slot.professionalId,
      professionalName: slot.professionalName,
    })),
    nextAvailable: next,
    durationMin: response.durationMin,
    priceCents: response.priceCents,
    timezone: response.timezone,
    minNoticeHours: settings.minNoticeHours,
  }
}

// ─── A criação ───────────────────────────────────────────────────────────────

export interface CreatedBooking {
  id: string
  status: string
  startsAt: string
  endsAt: string
  petName: string
  professionalName: string
  services: string[]
  totalCents: number
  awaitingApproval: boolean
  /** `true` quando o pedido reencontrou um agendamento que já existia (duplo toque). */
  duplicate: boolean
  /** As corridas criadas junto, quando o tutor pediu o leva-e-traz (MOD-PORTAL-07). */
  taxi: PortalTaxiRide[]
  /**
   * O que deu errado **só** com o transporte (AC-03 de MOD-PORTAL-07).
   *
   * O agendamento está criado quando este campo vem preenchido — é a diferença entre
   * "não deu para marcar" e "marcamos, mas o leva-e-traz não saiu". Perder o banho por
   * causa do transporte seria o pior desfecho possível, e é o que este campo evita.
   */
  taxiWarning: string | null
}

/**
 * AC-03 — cria o agendamento pelo Portal.
 *
 * **O duplo toque é resolvido pela pergunta natural**, e não por uma chave de
 * idempotência: o mesmo pet, no mesmo instante, com agendamento ainda em pé devolve o
 * que já existe. Num celular com 4G ruim é exatamente o que acontece — o tutor toca
 * duas vezes porque a primeira resposta demorou —, e uma chave gerada pela tela só
 * protegeria enquanto fosse a mesma tela.
 */
export async function createBooking(
  caller: SchedulingCaller,
  tutorId: string,
  input: PortalBookingInput,
): Promise<CreatedBooking> {
  const { settings, taxiSettings, existing } = await withTenant(caller.tenantId, async (tx) => {
    const found = await assertOnlineBooking(tx, caller.tenantId)
    await assertOwnsPet(tx, tutorId, input.petId)
    return {
      settings: found,
      taxiSettings: await readTaxiSettings(tx, caller.tenantId),
      existing: await findSameBooking(tx, tutorId, input.petId, new Date(input.startsAt)),
    }
  })

  if (existing) {
    /**
     * O duplo toque devolve o que existe **com as corridas que existem**.
     *
     * Sem isto, o segundo toque de quem pediu leva-e-traz responderia sem transporte
     * nenhum, e a tela diria que a corrida não saiu — quando ela saiu no primeiro toque.
     */
    const taxi = await withTenant(
      caller.tenantId,
      async (tx) =>
        (await readRidesByAppointment(tx, tutorId, [existing.id])).get(existing.id) ?? [],
    )
    return { ...existing, duplicate: true, taxi, taxiWarning: null }
  }

  /**
   * O leva-e-traz é decidido **antes** de o agendamento existir, e por isso está aqui.
   *
   * A ordem não é detalhe: a recusa por falta de vaga (AC-04) precisa acontecer com o
   * horário ainda livre, para o tutor escolher outro sem ter um agendamento a cancelar.
   * Já a recusa por endereço (AC-03) não derruba nada — o agendamento segue sem o taxi,
   * e o aviso viaja na resposta.
   */
  const plano = input.taxi
    ? await planTaxi(caller, tutorId, input, input.taxi, settings, taxiSettings.windowMinutes)
    : null

  let created
  try {
    created = await getSchedulingPort().create(caller, {
      petId: input.petId,
      professionalId: input.professionalId,
      startsAt: input.startsAt,
      serviceIds: input.serviceIds,
      notes: input.notes,
      acknowledgedAlerts: input.acknowledgedAlerts,
    })
  } catch (error) {
    throw translateBookingError(error, settings.timezone)
  }

  const taxi =
    plano && plano.ok
      ? await requestRides(caller, created, input.taxi!, taxiSettings.windowMinutes)
      : { rides: [], warning: plano?.warning ?? null }

  return {
    id: created.id,
    status: created.status,
    startsAt: created.startsAt,
    endsAt: created.endsAt,
    petName: created.petName,
    professionalName: created.professionalName,
    services: created.items.map((item) => item.label),
    totalCents: created.totalCents,
    awaitingApproval: created.status === 'PENDING',
    duplicate: false,
    taxi: taxi.rides,
    taxiWarning: taxi.warning,
  }
}

// ─── O leva-e-traz (MOD-PORTAL-07) ───────────────────────────────────────────

type TaxiPlan = { ok: true } | { ok: false; warning: string }

/**
 * A checagem que precede o agendamento: dá para buscar, e cabe alguém na van?
 *
 * A janela sondada aqui é calculada a partir da **duração somada dos serviços**, e não
 * do `ends_at` real — que ainda não existe, porque o agendamento não foi criado. É a
 * mesma soma que o domínio vai fazer, das mesmas linhas de `service_pricing`, então o
 * número bate; e se não batesse, a consequência seria uma sondagem alguns minutos fora,
 * não um pedido errado — a corrida é criada depois, com a janela do agendamento real.
 */
async function planTaxi(
  caller: SchedulingCaller,
  tutorId: string,
  input: PortalBookingInput,
  choice: PortalBookingTaxi,
  settings: BookingSettings,
  windowMinutes: number,
): Promise<TaxiPlan> {
  const offer = await readTaxiOffer(caller, tutorId)

  // AC-03: sem endereço, fora de área ou com o módulo desligado, o agendamento segue —
  // e o tutor lê o porquê no lugar de um erro. A tela já sabia disso pela oferta; quem
  // cai aqui é a tela velha, ou a chamada direta.
  if (!offer.available) return { ok: false, warning: offer.message ?? 'Leva-e-traz indisponível.' }

  const durationMin = await withTenant(caller.tenantId, (tx) =>
    sumDuration(tx, input.petId, input.serviceIds),
  )
  const startsAt = new Date(input.startsAt)
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000)

  await assertCapacity(caller, planLegs({ startsAt, endsAt }, windowMinutes, choice), () =>
    alternativesFor(caller, tutorId, input, choice, settings, windowMinutes),
  )

  return { ok: true }
}

/**
 * A duração do conjunto, pelo porte do pet.
 *
 * A mesma fonte de `listBookableServices` e a mesma que o `resolveItems` do domínio
 * congela no item — três lugares lendo `service_pricing` pelo `size_id`, e é assim que
 * a janela sondada aqui coincide com o atendimento que vai nascer.
 */
async function sumDuration(
  tx: TenantTransaction,
  petId: string,
  serviceIds: string[],
): Promise<number> {
  const pet = await tx.pet.findFirstOrThrow({ where: { id: petId }, select: { sizeId: true } })
  const pricing = await tx.servicePricing.findMany({
    where: { serviceId: { in: serviceIds }, sizeId: pet.sizeId },
    select: { durationMin: true },
  })
  return pricing.reduce((soma, linha) => soma + linha.durationMin, 0)
}

/**
 * Os horários do mesmo dia que ainda têm vaga no leva-e-traz (AC-04).
 *
 * Pergunta a grade de novo em vez de reaproveitar a que a tela já tem: entre a consulta
 * do tutor e o toque de confirmar passaram minutos, e oferecer como alternativa um
 * horário que também acabou de ser tomado é trocar uma frustração por duas.
 */
async function alternativesFor(
  caller: SchedulingCaller,
  tutorId: string,
  input: PortalBookingInput,
  choice: PortalBookingTaxi,
  settings: BookingSettings,
  windowMinutes: number,
): Promise<string[]> {
  try {
    const dia = zonedDate(new Date(input.startsAt), settings.timezone)
    const grade = await readAvailability(caller, tutorId, {
      petId: input.petId,
      serviceIds: input.serviceIds,
      date: dia,
    })

    const candidatos = grade.slots.filter((slot) => slot.startsAt !== input.startsAt)
    return await findAlternativeSlots(
      caller,
      candidatos.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })),
      windowMinutes,
      choice,
    )
  } catch (error) {
    logger.warn({ err: error }, 'falha ao montar alternativas de leva-e-traz')
    return []
  }
}

/**
 * O pedido da corrida, depois de o agendamento existir.
 *
 * **A falha aqui não desfaz o agendamento** (§5 do PRD): o banho está marcado, e desfazê-lo
 * porque a van recusou seria destruir o que deu certo por causa do que era acessório. O
 * tutor recebe o agendamento e o aviso sobre o transporte, e resolve o transporte falando
 * com a equipe.
 *
 * A janela sai do agendamento **criado**, não do pedido: é `starts_at` e `ends_at` reais
 * que o `assertCoherentWindow` do taxidog-service confere.
 */
async function requestRides(
  caller: SchedulingCaller,
  created: { id: string; startsAt: string; endsAt: string },
  choice: PortalBookingTaxi,
  windowMinutes: number,
): Promise<{ rides: PortalTaxiRide[]; warning: string | null }> {
  const legs = planLegs(
    { startsAt: new Date(created.startsAt), endsAt: new Date(created.endsAt) },
    windowMinutes,
    choice,
  )

  try {
    const rides = await getTaxiPort().createRides(caller, { appointmentId: created.id, legs })
    return {
      rides: rides.map((ride) =>
        toPortalRide({
          id: ride.id,
          leg: ride.leg,
          status: ride.status,
          windowStartsAt: new Date(ride.windowStartsAt),
          windowEndsAt: new Date(ride.windowEndsAt),
          priceCents: BigInt(ride.priceCents),
        }),
      ),
      warning: null,
    }
  } catch (error) {
    logger.error(
      { err: error, appointmentId: created.id },
      'agendamento criado, leva-e-traz recusado',
    )
    return {
      rides: [],
      warning:
        error instanceof AppError
          ? `Seu horário está marcado, mas o leva-e-traz não pôde ser confirmado: ${error.message}`
          : 'Seu horário está marcado, mas não foi possível confirmar o leva-e-traz. Fale com o estabelecimento.',
    }
  }
}

/**
 * O mesmo agendamento, feito há instantes.
 *
 * "Mesmo" é pet e horário de início — não o conjunto de serviços. Quem toca duas vezes
 * manda o mesmo pedido; quem realmente quer dois serviços no mesmo horário está pedindo
 * uma coisa que a agenda não faz, e o domínio recusaria por conflito de qualquer jeito.
 */
async function findSameBooking(
  tx: TenantTransaction,
  tutorId: string,
  petId: string,
  startsAt: Date,
): Promise<Omit<CreatedBooking, 'duplicate' | 'taxi' | 'taxiWarning'> | null> {
  const found = await tx.appointment.findFirst({
    where: { tutorId, petId, startsAt, status: { in: [...LIVE_STATUSES] } },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      totalCents: true,
      pet: { select: { name: true } },
      professional: { select: { displayName: true } },
      items: { select: { label: true } },
    },
  })
  if (!found) return null

  return {
    id: found.id,
    status: found.status,
    startsAt: found.startsAt.toISOString(),
    endsAt: found.endsAt.toISOString(),
    petName: found.pet.name,
    professionalName: found.professional.displayName,
    services: found.items.map((item) => item.label),
    totalCents: Number(found.totalCents),
    awaitingApproval: found.status === 'PENDING',
  }
}

/**
 * A tradução do §5: **o código atravessa, a mensagem não**.
 *
 * Reescrever `ERR_AGENDA_007` como `ERR_PORTAL_00x` esconderia a origem de quem for
 * depurar. Já a mensagem do domínio é escrita para o balcão, e chegar assim ao tutor o
 * manda ligar para o petshop — que é o telefonema que este módulo existe para evitar.
 */
function translateBookingError(error: unknown, timezone: string): unknown {
  if (!(error instanceof AppError)) return error
  const extra = (error.extra ?? {}) as Record<string, unknown>

  if (error.code === 'ERR_AGENDA_007') {
    // AC-04: o erro **sempre** aponta a saída. Sem a alternativa, o tutor fica sabendo
    // que não pode e não fica sabendo quando poderia.
    const hours = typeof extra.minNoticeHours === 'number' ? extra.minNoticeHours : null
    const next = typeof extra.nextAvailable === 'string' ? extra.nextAvailable : null
    const prazo = hours === 1 ? '1 hora' : `${hours ?? 2} horas`

    return new AppError(
      error.code,
      next
        ? `Agendamentos pelo site precisam de ${prazo} de antecedência. Escolha um horário a partir das ${horaEm(next, timezone)}.`
        : `Agendamentos pelo site precisam de ${prazo} de antecedência.`,
      undefined,
      extra,
    )
  }

  if (error.code === 'ERR_AGENDA_008') {
    // AC-05: sem override no Portal. `requiresOverride` sai do payload — a tela não
    // pode oferecer um botão que só a equipe tem.
    const { requiresOverride: _ignored, ...rest } = extra
    const debt = typeof extra.balanceCents === 'number' ? Math.max(0, -extra.balanceCents) : 0

    return new AppError(
      error.code,
      debt > 0
        ? `Há ${formatBRL(debt)} em aberto na sua conta. Fale com o estabelecimento para marcar este horário.`
        : 'Há pendências na sua conta. Fale com o estabelecimento para marcar este horário.',
      undefined,
      rest,
    )
  }

  if (error.code === 'ERR_AGENDA_004') {
    // AC-08: a corrida do último horário. Não é erro de servidor nem culpa de ninguém —
    // é o segundo lugar na fila, e as sugestões que vêm junto são a saída.
    return new AppError(
      error.code,
      'Este horário acabou de ser preenchido. Escolha um dos horários próximos.',
      undefined,
      extra,
    )
  }

  if (error.code === 'ERR_AGENDA_009') {
    // RN-09: alerta clínico. A mensagem do domínio já é dirigida a quem decide, e aqui
    // quem decide é o dono do animal — só o enquadramento muda.
    const labels = Array.isArray(extra.alerts)
      ? (extra.alerts as { label?: string }[]).map((alert) => alert.label).filter(Boolean)
      : []

    return new AppError(
      error.code,
      labels.length > 0
        ? `O cadastro do seu pet tem um alerta importante (${labels.join(', ')}) para o serviço escolhido. Confirme para que a equipe seja avisada.`
        : 'O cadastro do seu pet tem um alerta importante para o serviço escolhido. Confirme para que a equipe seja avisada.',
      undefined,
      extra,
    )
  }

  if (error.code === 'ERR_AGENDA_010') {
    return invalid('Este pet não está disponível para agendamento.')
  }

  return error
}

/**
 * A hora de um instante, no fuso do estabelecimento (RN-19).
 *
 * O fuso vem das configurações do tenant, e não do erro: o domínio devolve o instante
 * em UTC, e formatá-lo no fuso do servidor faria a mensagem dizer 08:00 para um
 * agendamento das 11:00.
 */
function horaEm(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
