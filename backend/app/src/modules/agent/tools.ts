import type Anthropic from '@anthropic-ai/sdk'
import type { ZodError } from 'zod'
import {
  AGENT_PROPOSAL_TTL_MIN,
  AppError,
  ProporAgendamentoArgsSchema,
  ProporCancelamentoArgsSchema,
  ProporRemarcacaoArgsSchema,
  formatBRL,
  zonedDate,
} from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { invalid, validationError } from './errors.js'
import { getAgentPortalPort } from './portal-port.js'
import {
  confirmProposal,
  newProposalToken,
  proposalExpiry,
  type ProposalScope,
  type ToolRecord,
} from './proposals.js'

/**
 * As dez tools do agente: sete leituras (MOD-AI-03) e três escritas (MOD-AI-04).
 *
 * **Elas não foram escritas, foram escolhidas.** Toda função que o agente chama já existe,
 * já valida, já respeita o escopo do tutor e já é a mesma que a tela do Portal usa. O
 * trabalho aqui é o recorte: quais delas ele alcança, com que ator, e o que acontece
 * quando ele erra.
 *
 * Três regras valem para todas, e as três são a razão de o arquivo existir:
 *
 * 1. **Nenhuma recebe `tutorId`** (RN-02). O escopo vem da conversa. Um argumento de
 *    escopo que o modelo pudesse preencher seria a falha inteira do módulo.
 * 2. **`strict: true` em todas** (§5). O argumento chega válido e vai direto à função de
 *    domínio, sem uma segunda tradução no meio.
 * 3. **Erro vira `tool_result` com `is_error`** (AC-05), nunca exceção que sobe e nunca
 *    resultado omitido. A tool que falha diz que falhou; o agente diz que não conseguiu
 *    consultar e a conversa vai para gente. **A tool nunca inventa resposta.**
 *
 * O que **não** está aqui é tão importante quanto o que está: não há tool de alergia, de
 * prontuário, de endereço nem de valor exato de dívida, e nenhuma de lançamento
 * financeiro, registro clínico, alteração de ficha ou envio de campanha (AC-06, RN-06). O
 * telefone identifica, não autentica (RN-01) — e dado de saúde não sai por um canal cuja
 * prova de identidade é o número de quem escreveu.
 *
 * **As três escritas são propostas, e não escritas** (RN-03). Elas não gravam nada: a
 * proposta fica registrada com um token, e quem grava é `confirmarProposta`, no turno em
 * que o cliente disser sim. O porquê está em `proposals.ts`.
 */

export type ToolScope = ProposalScope & {
  /** O que este turno deixou para gravar quando a linha do turno existir. */
  records: ToolRecord[]
}

/** O texto que a tool devolve ao modelo, e se ele deve lê-lo como falha. */
interface ToolOutcome {
  text: string
  isError: boolean
  /** A conversa precisa ir para gente depois desta resposta (AC-05 de MOD-AI-04). */
  handoff?: boolean
}

/** O resultado de uma tool: o que volta ao modelo e a linha curta que fica no registro. */
interface ToolResult {
  text: string
  summary: string
  /**
   * Presente só nas três propostas. Os argumentos vêm aqui, e não do que o modelo mandou:
   * a proposta guarda o horário **como o domínio o emitiu**, e não como o modelo o
   * escreveu.
   */
  proposal?: { token: string; expiresAt: Date; args: unknown }
}

/**
 * A definição das tools, **constante e na mesma ordem sempre**.
 *
 * Ordem determinística não é capricho: `tools` é o primeiro bloco do prefixo em cache, e
 * uma lista que mudasse de ordem por tenant invalidaria o cache de todo mundo em silêncio
 * — o módulo continuaria funcionando e a conta triplicaria (§10).
 */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'listarMeusPets',
    description:
      'Lista os pets do cliente com quem você está falando: nome, espécie, raça, idade ' +
      'e o próximo agendamento de cada um. Use para descobrir o id de um pet antes de ' +
      'consultar horários ou serviços.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'listarProximosAgendamentos',
    description:
      'Os próximos agendamentos do cliente: data, hora, pet, serviços e profissional. ' +
      'Use para responder "que horas é o banho?" e "quando é a próxima?".',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'horarioDoEstabelecimento',
    description:
      'O nome do estabelecimento e se o agendamento pelo site está disponível. Use ' +
      'quando o cliente perguntar sobre a loja.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'listarServicos',
    description:
      'Os serviços que podem ser marcados para um pet, com preço e duração já ' +
      'calculados para o porte e a pelagem dele.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { petId: { type: 'string', description: 'O id do pet, de listarMeusPets.' } },
      required: ['petId'],
      additionalProperties: false,
    },
  },
  {
    name: 'consultarDisponibilidade',
    description:
      'Os horários livres de um dia para um pet e uma combinação de serviços. Resolva ' +
      '"quinta" ou "amanhã" para a data antes de chamar — hoje é informado no contexto.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        petId: { type: 'string', description: 'O id do pet, de listarMeusPets.' },
        serviceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Os ids dos serviços, de listarServicos.',
        },
        date: { type: 'string', description: 'O dia, no formato AAAA-MM-DD.' },
      },
      required: ['petId', 'serviceIds', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'situacaoFinanceira',
    description:
      'Diz **se** há valores em aberto na conta do cliente e como pagar. Nunca devolve ' +
      'o valor exato: para ver o extrato, o cliente entra no Portal.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'statusDoTaxi',
    description:
      'Se o leva-e-traz está disponível para o endereço do cliente e quanto custa cada ' +
      'trecho.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },

  /**
   * As três propostas. **Nenhuma delas marca, cancela ou remarca coisa alguma** — a
   * descrição diz isso na primeira linha porque é o que o modelo precisa entender para
   * não prometer ao cliente o que ainda não aconteceu.
   */
  {
    name: 'proporAgendamento',
    description:
      'Propõe um horário ao cliente. NÃO marca nada: confere se o horário está livre e ' +
      'devolve um código de confirmação. Diga ao cliente o dia, a hora, o serviço, o ' +
      'profissional e o preço, e pergunte se ele confirma. Só depois que ele responder ' +
      'que sim, chame confirmarProposta com o código.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        petId: { type: 'string', description: 'O id do pet, de listarMeusPets.' },
        serviceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Os ids dos serviços, de listarServicos.',
        },
        professionalId: {
          type: 'string',
          description: 'O id do profissional, de consultarDisponibilidade.',
        },
        startsAt: {
          type: 'string',
          description: 'O começo do horário, exatamente como consultarDisponibilidade o devolveu.',
        },
      },
      required: ['petId', 'serviceIds', 'professionalId', 'startsAt'],
      additionalProperties: false,
    },
  },
  {
    name: 'proporCancelamento',
    description:
      'Propõe cancelar um agendamento. NÃO cancela nada: devolve um código de ' +
      'confirmação e, quando houver, o valor da taxa de cancelamento. Diga a taxa ao ' +
      'cliente ANTES de ele confirmar. Só depois do sim, chame confirmarProposta.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'O id do agendamento, de listarProximosAgendamentos.',
        },
      },
      required: ['appointmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'proporRemarcacao',
    description:
      'Propõe mover um agendamento para outro horário. NÃO remarca nada: confere se o ' +
      'horário novo está livre e devolve um código de confirmação. Consulte a ' +
      'disponibilidade antes. Só depois do sim do cliente, chame confirmarProposta.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'O id do agendamento que vai mudar de horário.',
        },
        professionalId: {
          type: 'string',
          description: 'O id do profissional do horário novo, de consultarDisponibilidade.',
        },
        startsAt: {
          type: 'string',
          description: 'O começo do horário novo, como consultarDisponibilidade o devolveu.',
        },
      },
      required: ['appointmentId', 'professionalId', 'startsAt'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirmarProposta',
    description:
      'A ÚNICA ferramenta que grava. Use apenas depois de o cliente ter confirmado, na ' +
      'mensagem dele, a proposta que você fez. Se ele não confirmou com clareza, ' +
      'pergunte de novo em vez de chamar isto.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        confirmationToken: {
          type: 'string',
          description: 'O código devolvido pela proposta que o cliente acabou de confirmar.',
        },
      },
      required: ['confirmationToken'],
      additionalProperties: false,
    },
  },
]

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => tool.name))

export async function runTool(
  scope: ToolScope,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  /**
   * A confirmação não passa pelo registro deste arquivo.
   *
   * Ela não **cria** uma linha: fecha a que a proposta abriu, com `CONFIRMED` ou
   * `FAILED`. Uma segunda linha dizendo "o modelo chamou confirmarProposta" contaria a
   * mesma coisa duas vezes, e a que importa é a que tem os argumentos.
   */
  if (name === 'confirmarProposta') return confirmProposal(scope, input)

  try {
    const result = await execute(scope, name, input)
    scope.records.push(
      result.proposal
        ? {
            tool: name,
            args: result.proposal.args,
            status: 'PROPOSED',
            summary: result.summary,
            token: result.proposal.token,
            expiresAt: result.proposal.expiresAt,
          }
        : { tool: name, args: input, status: 'EXECUTED', summary: result.summary },
    )
    return { text: result.text, isError: false }
  } catch (error) {
    /**
     * O erro de domínio vira frase legível, e o técnico fica no log.
     *
     * Um `AppError` do Portal ("Pet não encontrado") é exatamente o que o modelo precisa
     * ler para se corrigir — é o AC-02, e é o que acontece quando ele tenta um `petId`
     * que não é do cliente da conversa. Qualquer outra coisa é defeito nosso, e aí o
     * modelo só precisa saber que a consulta falhou.
     */
    const message = error instanceof AppError ? error.message : 'Não consegui consultar isso agora.'

    if (!(error instanceof AppError)) {
      logger.error({ err: error, tool: name, tenantId: scope.tenantId }, 'tool do agente falhou')
    }

    scope.records.push({ tool: name, args: input, status: 'FAILED', summary: message })
    return { text: message, isError: true }
  }
}

async function execute(scope: ToolScope, name: string, input: unknown): Promise<ToolResult> {
  const port = getAgentPortalPort()
  const { tenantId, tutorId } = scope

  switch (name) {
    case 'listarMeusPets': {
      const pets = await port.pets(tenantId, tutorId)
      return {
        text: json(
          pets.map((pet) => ({
            petId: pet.id,
            nome: pet.name,
            especie: pet.species,
            raca: pet.breed,
            idade: pet.ageLabel,
            // O falecido continua na lista, como no Portal, e marcado: o agente não pode
            // oferecer banho para quem morreu.
            emMemoria: pet.inMemoriam,
            proximoAgendamento: pet.nextAppointment
              ? {
                  quando: pet.nextAppointment.startsAt,
                  servicos: pet.nextAppointment.services,
                }
              : null,
          })),
        ),
        summary: contar(pets.length, 'pet', 'pets'),
      }
    }

    case 'listarProximosAgendamentos': {
      const response = await port.appointments(tenantId, tutorId)
      return {
        text: json(
          response.upcoming.map((appointment) => ({
            agendamentoId: appointment.id,
            quando: appointment.startsAt,
            pet: appointment.petName,
            servicos: appointment.services,
            profissional: appointment.professionalName,
            situacao: appointment.awaitingApproval ? 'aguardando confirmação' : appointment.status,
            podeCancelar: appointment.actions.canCancel,
            podeRemarcar: appointment.actions.canReschedule,
          })),
        ),
        summary: contar(response.upcoming.length, 'agendamento', 'agendamentos'),
      }
    }

    case 'horarioDoEstabelecimento': {
      const tenant = await port.tenant(tenantId)
      return {
        text: json({ nome: tenant.name, agendamentoOnline: tenant.portalEnabled }),
        summary: 'consultou o estabelecimento',
      }
    }

    case 'listarServicos': {
      const { petId } = asObject(input)
      const response = await port.services(tenantId, tutorId, requireString(petId, 'petId'))
      return {
        text: json({
          pet: response.petName,
          servicos: response.services.map((service) => ({
            serviceId: service.id,
            nome: service.name,
            preco: formatBRL(service.priceCents),
            duracaoMin: service.durationMin,
          })),
        }),
        summary: contar(response.services.length, 'serviço', 'serviços'),
      }
    }

    case 'consultarDisponibilidade': {
      const { petId, serviceIds, date } = asObject(input)
      const response = await port.availability(tenantId, tutorId, {
        petId: requireString(petId, 'petId'),
        serviceIds: requireStringArray(serviceIds, 'serviceIds'),
        date: requireString(date, 'date'),
      })
      return {
        text: json({
          // Dez horários bastam para o cliente escolher; a grade inteira de um dia é
          // prompt pago em todos os turnos seguintes.
          horarios: response.slots.slice(0, 10).map((slot) => ({
            comeca: slot.startsAt,
            profissionalId: slot.professionalId,
            profissional: slot.professionalName,
          })),
          proximoDisponivel: response.nextAvailable,
          duracaoMin: response.durationMin,
          preco: formatBRL(response.priceCents),
        }),
        summary: contar(response.slots.length, 'horário livre', 'horários livres'),
      }
    }

    case 'situacaoFinanceira': {
      const finance = await port.finance(tenantId, tutorId)
      /**
       * **A faixa, e nunca o valor** (AC-03 de MOD-AI-03, RN-01).
       *
       * O telefone identifica; ele não autentica. Um número clonado não pode render o
       * valor exato da dívida de alguém — e a resposta que o produto oferece no lugar é
       * a que resolve de verdade: entrar no Portal, onde há sessão.
       */
      return {
        text: json({
          temValoresEmAberto: finance.openDebitsCents > 0,
          temCredito: finance.balanceCents > 0,
          comoPagar: {
            pix: finance.howToPay.pixKey ? 'disponível' : null,
            telefone: finance.howToPay.phone,
          },
          observacao:
            'Nunca diga valores. Para ver o extrato com os valores, o cliente entra no ' +
            'Portal do Tutor com o telefone dele.',
        }),
        summary: finance.openDebitsCents > 0 ? 'há valores em aberto' : 'sem valores em aberto',
      }
    }

    case 'statusDoTaxi': {
      const offer = await port.taxi(tenantId, tutorId)
      return {
        text: json({
          disponivel: offer.available,
          motivo: offer.message,
          precoPorTrecho: offer.priceCentsPerLeg ? formatBRL(offer.priceCentsPerLeg) : null,
          janelaMinutos: offer.windowMinutes,
        }),
        summary: offer.available ? 'leva-e-traz disponível' : 'leva-e-traz indisponível',
      }
    }

    case 'proporAgendamento':
      return proporAgendamento(scope, input)

    case 'proporCancelamento':
      return proporCancelamento(scope, input)

    case 'proporRemarcacao':
      return proporRemarcacao(scope, input)

    default:
      // O modelo pediu uma tool que não existe. Acontece, e a resposta certa é dizer.
      return { text: `A ferramenta "${name}" não existe.`, summary: 'ferramenta inexistente' }
  }
}

// ─── As três propostas (MOD-AI-04) ───────────────────────────────────────────

/**
 * A proposta de horário (AC-01).
 *
 * **Ela reconsulta a grade em vez de confiar no que o modelo escolheu**, e a consulta é a
 * do Portal: mesma antecedência mínima, mesma posse do pet, mesmo filtro de agendamento
 * online. Sem isso, o agente proporia com confiança um horário que o `createBooking`
 * recusaria depois do "sim" — e o cliente teria confirmado uma coisa que não existe.
 *
 * Do slot reconsultado sai também o que a frase precisa ter: o nome do profissional, a
 * duração e o preço, que é o do porte e da pelagem daquele pet.
 */
async function proporAgendamento(scope: ToolScope, input: unknown): Promise<ToolResult> {
  const args = parseArgs(ProporAgendamentoArgsSchema, input)
  const port = getAgentPortalPort()

  const grade = await port.availability(scope.tenantId, scope.tutorId, {
    petId: args.petId,
    serviceIds: args.serviceIds,
    date: zonedDate(new Date(args.startsAt), scope.timezone),
  })

  const slot = grade.slots.find(
    (livre) =>
      new Date(livre.startsAt).getTime() === new Date(args.startsAt).getTime() &&
      livre.professionalId === args.professionalId,
  )

  if (!slot) {
    throw invalid(
      'Esse horário não está mais livre. Consulte a disponibilidade de novo e ofereça outro.',
    )
  }

  const token = newProposalToken()
  return {
    text: json({
      confirmationToken: token,
      oQueSeraFeito: 'marcar',
      quando: slot.startsAt,
      profissional: slot.professionalName,
      duracaoMin: grade.durationMin,
      preco: formatBRL(grade.priceCents),
      validoPorMinutos: AGENT_PROPOSAL_TTL_MIN,
      instrucao:
        'Nada foi marcado ainda. Confirme com o cliente dizendo dia, hora, profissional ' +
        'e preço, e só chame confirmarProposta depois que ele responder que sim.',
    }),
    summary: `propôs marcar ${horaLocal(slot.startsAt, scope.timezone)}`,
    proposal: {
      token,
      expiresAt: proposalExpiry(),
      // O `startsAt` que vai ao banco é o **do slot**, e não o que o modelo escreveu: os
      // dois apontam para o mesmo instante, e só um está no formato que o domínio emitiu.
      args: { ...args, startsAt: slot.startsAt, professionalId: slot.professionalId },
    },
  }
}

/**
 * A proposta de cancelamento (AC-01, e o AC-03 de MOD-PORTAL-06 por tabela).
 *
 * **A taxa é dita antes**, e é a razão de esta etapa existir para o cancelamento. Quem
 * cancela pela véspera não tem atendente para avisar que vai ser cobrado, e uma cobrança
 * que aparece depois no extrato é a pior forma de descobrir a regra. A confirmação que
 * vem a seguir é o `acknowledgeFee` que o Portal pede da tela.
 */
async function proporCancelamento(scope: ToolScope, input: unknown): Promise<ToolResult> {
  const args = parseArgs(ProporCancelamentoArgsSchema, input)
  const appointment = await getAgentPortalPort().appointment(
    scope.tenantId,
    scope.tutorId,
    args.appointmentId,
  )

  if (!appointment.actions.canCancel) {
    throw invalid('Este agendamento não pode mais ser cancelado por aqui.')
  }

  const taxa = appointment.actions.cancelIsLate ? appointment.actions.cancelFeeCents : 0
  const token = newProposalToken()

  return {
    text: json({
      confirmationToken: token,
      oQueSeraFeito: 'cancelar',
      quando: appointment.startsAt,
      pet: appointment.petName,
      servicos: appointment.services,
      taxaDeCancelamento: taxa > 0 ? formatBRL(taxa) : null,
      validoPorMinutos: AGENT_PROPOSAL_TTL_MIN,
      instrucao:
        taxa > 0
          ? 'Nada foi cancelado ainda. Diga ao cliente o valor da taxa e confirme se ele ' +
            'quer mesmo cancelar antes de chamar confirmarProposta.'
          : 'Nada foi cancelado ainda. Confirme com o cliente antes de chamar confirmarProposta.',
    }),
    summary: taxa > 0 ? 'propôs cancelar, com taxa' : 'propôs cancelar',
    proposal: { token, expiresAt: proposalExpiry(), args },
  }
}

/**
 * A proposta de remarcação (AC-01).
 *
 * Os serviços saem do **agendamento**, e não dos argumentos: remarcar é mover o mesmo
 * atendimento, e a grade do dia novo depende da duração daquele conjunto. Deixar o modelo
 * reescolher os serviços transformaria uma remarcação em um agendamento diferente com
 * cara de remarcação.
 */
async function proporRemarcacao(scope: ToolScope, input: unknown): Promise<ToolResult> {
  const args = parseArgs(ProporRemarcacaoArgsSchema, input)
  const port = getAgentPortalPort()

  const appointment = await port.appointment(scope.tenantId, scope.tutorId, args.appointmentId)
  if (!appointment.actions.canReschedule) {
    throw invalid('Este agendamento não pode mais ser remarcado por aqui.')
  }

  const grade = await port.availability(scope.tenantId, scope.tutorId, {
    petId: appointment.petId,
    serviceIds: appointment.serviceIds,
    date: zonedDate(new Date(args.startsAt), scope.timezone),
  })

  const slot = grade.slots.find(
    (livre) =>
      new Date(livre.startsAt).getTime() === new Date(args.startsAt).getTime() &&
      livre.professionalId === args.professionalId,
  )

  if (!slot) {
    throw invalid(
      'Esse horário não está mais livre. Consulte a disponibilidade de novo e ofereça outro.',
    )
  }

  const token = newProposalToken()
  return {
    text: json({
      confirmationToken: token,
      oQueSeraFeito: 'remarcar',
      de: appointment.startsAt,
      para: slot.startsAt,
      pet: appointment.petName,
      profissional: slot.professionalName,
      // O preço é recalculado para a data nova pelo domínio (AC-04 de MOD-PORTAL-06).
      preco: formatBRL(grade.priceCents),
      validoPorMinutos: AGENT_PROPOSAL_TTL_MIN,
      instrucao:
        'Nada foi remarcado ainda. Confirme o horário novo com o cliente antes de ' +
        'chamar confirmarProposta.',
    }),
    summary: `propôs remarcar para ${horaLocal(slot.startsAt, scope.timezone)}`,
    proposal: {
      token,
      expiresAt: proposalExpiry(),
      args: { ...args, startsAt: slot.startsAt, professionalId: slot.professionalId },
    },
  }
}

// ─── Peças ───────────────────────────────────────────────────────────────────

/**
 * Os argumentos da proposta, validados pelo mesmo schema que o §5 do PRD declara.
 *
 * O `strict: true` da definição já garante a forma do lado do provedor; este Zod garante
 * o que ele não aceita declarar — que os ids são UUID e que a data é uma data. E o erro
 * volta **ao modelo**, com o campo que faltou: um "argumento inválido" genérico o faria
 * tentar a mesma coisa de novo.
 */
function parseArgs<T>(schema: { safeParse(input: unknown): SafeParse<T> }, input: unknown): T {
  const parsed = schema.safeParse(asObject(input))
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

type SafeParse<T> = { success: true; data: T } | { success: false; error: ZodError }

/** O resumo que a recepção lê na conversa: "3 horários livres", "nenhum pet". */
function contar(total: number, singular: string, plural: string): string {
  if (total === 0) return `nenhum ${singular}`
  return `${total} ${total === 1 ? singular : plural}`
}

/** Dia e hora no fuso do estabelecimento, para o resumo em claro. */
function horaLocal(isoDate: string, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoDate))
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new AppError('ERR_AI_002', `Falta "${field}".`)
  return value
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError('ERR_AI_002', `Falta "${field}".`)
  }
  return value.map((item) => requireString(item, field))
}
