import type Anthropic from '@anthropic-ai/sdk'
import { AppError, formatBRL } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { getAgentPortalPort } from './portal-port.js'

/**
 * As sete tools de leitura (MOD-AI-03).
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
 * prontuário, de endereço nem de valor exato de dívida. O telefone identifica, não
 * autentica (RN-01) — e dado de saúde não sai por um canal cuja prova de identidade é o
 * número de quem escreveu.
 */

export interface ToolScope {
  tenantId: string
  tutorId: string
  timezone: string
}

/** O texto que a tool devolve ao modelo, e se ele deve lê-lo como falha. */
interface ToolOutcome {
  text: string
  isError: boolean
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
]

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => tool.name))

export async function runTool(
  scope: ToolScope,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  try {
    return { text: await execute(scope, name, input), isError: false }
  } catch (error) {
    /**
     * O erro de domínio vira frase legível, e o técnico fica no log.
     *
     * Um `AppError` do Portal ("Pet não encontrado") é exatamente o que o modelo precisa
     * ler para se corrigir — é o AC-02, e é o que acontece quando ele tenta um `petId`
     * que não é do cliente da conversa. Qualquer outra coisa é defeito nosso, e aí o
     * modelo só precisa saber que a consulta falhou.
     */
    if (error instanceof AppError) return { text: error.message, isError: true }

    logger.error({ err: error, tool: name, tenantId: scope.tenantId }, 'tool do agente falhou')
    return { text: 'Não consegui consultar isso agora.', isError: true }
  }
}

async function execute(scope: ToolScope, name: string, input: unknown): Promise<string> {
  const port = getAgentPortalPort()
  const { tenantId, tutorId } = scope

  switch (name) {
    case 'listarMeusPets': {
      const pets = await port.pets(tenantId, tutorId)
      return json(
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
      )
    }

    case 'listarProximosAgendamentos': {
      const response = await port.appointments(tenantId, tutorId)
      return json(
        response.upcoming.map((appointment) => ({
          quando: appointment.startsAt,
          pet: appointment.petName,
          servicos: appointment.services,
          profissional: appointment.professionalName,
          situacao: appointment.awaitingApproval ? 'aguardando confirmação' : appointment.status,
        })),
      )
    }

    case 'horarioDoEstabelecimento': {
      const tenant = await port.tenant(tenantId)
      return json({ nome: tenant.name, agendamentoOnline: tenant.portalEnabled })
    }

    case 'listarServicos': {
      const { petId } = asObject(input)
      const response = await port.services(tenantId, tutorId, requireString(petId, 'petId'))
      return json({
        pet: response.petName,
        servicos: response.services.map((service) => ({
          serviceId: service.id,
          nome: service.name,
          preco: formatBRL(service.priceCents),
          duracaoMin: service.durationMin,
        })),
      })
    }

    case 'consultarDisponibilidade': {
      const { petId, serviceIds, date } = asObject(input)
      const response = await port.availability(tenantId, tutorId, {
        petId: requireString(petId, 'petId'),
        serviceIds: requireStringArray(serviceIds, 'serviceIds'),
        date: requireString(date, 'date'),
      })
      return json({
        // Dez horários bastam para o cliente escolher; a grade inteira de um dia é
        // prompt pago em todos os turnos seguintes.
        horarios: response.slots.slice(0, 10).map((slot) => ({
          comeca: slot.startsAt,
          profissional: slot.professionalName,
        })),
        proximoDisponivel: response.nextAvailable,
        duracaoMin: response.durationMin,
        preco: formatBRL(response.priceCents),
      })
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
      return json({
        temValoresEmAberto: finance.openDebitsCents > 0,
        temCredito: finance.balanceCents > 0,
        comoPagar: {
          pix: finance.howToPay.pixKey ? 'disponível' : null,
          telefone: finance.howToPay.phone,
        },
        observacao:
          'Nunca diga valores. Para ver o extrato com os valores, o cliente entra no ' +
          'Portal do Tutor com o telefone dele.',
      })
    }

    case 'statusDoTaxi': {
      const offer = await port.taxi(tenantId, tutorId)
      return json({
        disponivel: offer.available,
        motivo: offer.message,
        precoPorTrecho: offer.priceCentsPerLeg ? formatBRL(offer.priceCentsPerLeg) : null,
        janelaMinutos: offer.windowMinutes,
      })
    }

    default:
      // O modelo pediu uma tool que não existe. Acontece, e a resposta certa é dizer.
      return `A ferramenta "${name}" não existe.`
  }
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
