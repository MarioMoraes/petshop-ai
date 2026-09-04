import { signServiceHeaders } from '@petshop/service-auth'
import {
  AppError,
  ERROR_CATALOG,
  type AppointmentResponse,
  type AvailabilityResponse,
  type ErrorCode,
  type FieldError,
  type PermissionKey,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { logger } from '../../lib/logger.js'
import { upstreamUnavailable } from '../../lib/errors.js'

/**
 * A porta para o scheduling-service.
 *
 * **Por que HTTP, se o BFF lê o banco direto no resto do módulo.** Ler é escolher um
 * recorte; agendar é aplicar regra. A criação do agendamento tem transação
 * `SERIALIZABLE` na janela do profissional, três gates, preço congelado, evento e
 * auditoria — reimplementar isso aqui produziria uma segunda agenda, que divergiria da
 * primeira no dia em que uma das duas mudasse. O §5 do PRD já dizia: o BFF **agrega**,
 * quem valida é o serviço de domínio.
 *
 * **O contexto assinado é a parte perigosa, e por isso é curta.** O papel `TUTOR` não
 * tem `schedule:write_all`; esta porta assina um contexto que tem. A elevação é real e
 * está contida em três coisas:
 *
 * 1. quem chama já provou a posse — o pet e o agendamento foram carregados pelo escopo
 *    `_own` antes de qualquer chamada daqui;
 * 2. `schedule:override_credit` **nunca** é assinado, e é o que garante o AC-05: o
 *    devedor não libera a própria exceção;
 * 3. o `userId` que vai na assinatura é o do tutor, não o do serviço — a auditoria do
 *    outro lado grava quem realmente marcou.
 *
 * O erro do domínio **atravessa com o código original** (§5). O que o BFF reescreve é a
 * mensagem, para linguagem de cliente: "ERR_AGENDA_007" com o texto do balcão manda o
 * tutor procurar um atendente, que é exatamente o que o módulo existe para evitar.
 */

export interface SchedulingCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
}

export interface AvailabilityRequest {
  petId: string
  serviceIds: string[]
  from: string
  to: string
}

export interface CreateAppointmentRequest {
  petId: string
  professionalId: string
  startsAt: string
  serviceIds: string[]
  notes?: string | undefined
  acknowledgedAlerts: boolean
}

export interface RescheduleRequest {
  startsAt: string
  professionalId: string
}

export interface SchedulingPort {
  availability(caller: SchedulingCaller, input: AvailabilityRequest): Promise<AvailabilityResponse>
  create(caller: SchedulingCaller, input: CreateAppointmentRequest): Promise<AppointmentResponse>
  cancel(caller: SchedulingCaller, appointmentId: string): Promise<AppointmentResponse>
  reschedule(
    caller: SchedulingCaller,
    appointmentId: string,
    input: RescheduleRequest,
  ): Promise<AppointmentResponse>
}

const REQUEST_TIMEOUT_MS = 10_000

/** O mínimo para cada operação. Ler não escreve, e nenhuma delas libera crédito. */
const READ_PERMISSIONS: PermissionKey[] = ['schedule:read_all']
const WRITE_PERMISSIONS: PermissionKey[] = ['schedule:read_all', 'schedule:write_all']

interface ProblemBody {
  code?: string
  detail?: string
  [key: string]: unknown
}

function createHttpPort(): SchedulingPort {
  async function call<T>(
    caller: SchedulingCaller,
    permissions: PermissionKey[],
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const env = loadEnv()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let response: Response
    try {
      const headers = signServiceHeaders(
        {
          clerkUserId: caller.clerkUserId,
          ...(caller.userId ? { userId: caller.userId } : {}),
          tenantId: caller.tenantId,
          permissions: [...permissions],
        },
        env.INTERNAL_SERVICE_SECRET,
      )

      response = await fetch(`${env.SCHEDULING_SERVICE_URL}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      // Rede, DNS ou timeout. Não há resposta nenhuma para interpretar, e inventar uma
      // lista de horários vazia diria ao tutor que o petshop não tem vaga.
      logger.error({ err: error, path }, 'falha ao falar com o scheduling-service')
      throw upstreamUnavailable()
    } finally {
      clearTimeout(timeout)
    }

    const payload = (await response.json().catch(() => null)) as ProblemBody | null

    if (!response.ok) {
      /**
       * Código que este processo não conhece vira 502, e não 500.
       *
       * `new AppError(code)` lê o status do catálogo; um código de fora dele estouraria
       * dentro do construtor e o Portal responderia erro de servidor a um erro de
       * negócio perfeitamente descritível do outro lado. Acontece de verdade quando os
       * dois serviços sobem em versões diferentes.
       */
      const conhecido = payload?.code !== undefined && payload.code in ERROR_CATALOG

      if (response.status >= 500 || !conhecido) {
        logger.error(
          { status: response.status, path, detail: payload?.detail },
          'scheduling-service recusou a operação do Portal',
        )
        throw upstreamUnavailable()
      }

      /**
       * `title`, `status` e `type` são a moldura do problem+json e o handler de erro
       * daqui as reconstrói; repassá-las faria a resposta do Portal carregar o status
       * do outro serviço. O resto do corpo é o contexto do erro — `suggestions`,
       * `alerts`, `balanceCents` — e é ele que precisa atravessar.
       */
      const {
        code,
        detail,
        title: _title,
        status: _status,
        type: _type,
        fields,
        ...extra
      } = payload
      throw new AppError(
        code as ErrorCode,
        typeof detail === 'string' ? detail : 'Não foi possível concluir',
        Array.isArray(fields) ? (fields as FieldError[]) : undefined,
        Object.keys(extra).length > 0 ? extra : undefined,
      )
    }

    return payload as T
  }

  return {
    availability(caller, input) {
      const query = new URLSearchParams({
        petId: input.petId,
        serviceIds: input.serviceIds.join(','),
        from: input.from,
        to: input.to,
      })
      return call(caller, READ_PERMISSIONS, 'GET', `/v1/availability?${query.toString()}`)
    },

    create(caller, input) {
      return call(caller, WRITE_PERMISSIONS, 'POST', '/v1/appointments', {
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        items: input.serviceIds.map((serviceId) => ({ serviceId })),
        ...(input.notes ? { notes: input.notes } : {}),
        acknowledgedAlerts: input.acknowledgedAlerts,
        // O que faz a antecedência mínima valer (RN-07) e o que marca a origem no
        // relatório do petshop. Sem isto o agendamento do Portal seria indistinguível
        // do que a recepção digitou.
        source: 'PORTAL',
      })
    },

    cancel(caller, appointmentId) {
      /**
       * Sem `waiveFee`: isentar a taxa é decisão da equipe. O corpo vazio deixa o
       * padrão do domínio valer, e o padrão é cobrar quando o cancelamento é tardio.
       */
      return call(
        caller,
        WRITE_PERMISSIONS,
        'POST',
        `/v1/appointments/${appointmentId}/cancel`,
        { reason: 'Cancelado pelo tutor no Portal' },
      )
    },

    reschedule(caller, appointmentId, input) {
      return call(
        caller,
        WRITE_PERMISSIONS,
        'POST',
        `/v1/appointments/${appointmentId}/reschedule`,
        { startsAt: input.startsAt, professionalId: input.professionalId },
      )
    },
  }
}

let port: SchedulingPort | null = null

export function getSchedulingPort(): SchedulingPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setSchedulingPort(next: SchedulingPort | null): void {
  port = next
}
