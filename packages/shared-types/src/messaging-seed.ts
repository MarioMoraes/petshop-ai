import type { MessageCategory, MessageChannel } from './messaging.js'

/**
 * Os textos que todo petshop começa tendo (PRD relacionamento_crm_08 §2, MOD-CRM-02).
 *
 * Ficam em código, não em linhas semeadas no banco: o petshop só ganha uma linha em
 * `message_templates` quando **muda** o texto, e a tela mostra a união dos dois. Isso
 * dá os textos aos tenants que já existiam sem backfill, e acrescentar um template
 * novo aqui não exige migration de dados.
 *
 * O tom é deliberadamente seco e sem emoji. Mensagem automática que tenta soar íntima
 * é o que faz o cliente perceber que é um robô; a que informa com clareza, não.
 */

export interface MessageTemplateDefinition {
  key: string
  category: MessageCategory
  /** Whitelist validada na gravação (AC-03 de MOD-CRM-02). */
  variables: readonly string[]
  /** Só EMAIL usa assunto. */
  subject?: string
  body: Record<MessageChannel, string>
}

/**
 * Variáveis comuns a todo template. `petshop.*` sai da identidade do tenant e
 * `tutor.*` do cadastro — nenhum template precisa pedi-las.
 */
const BASE_VARIABLES = [
  'tutor.nome',
  'tutor.primeiro_nome',
  'petshop.nome',
  'petshop.telefone',
] as const

const APPOINTMENT_VARIABLES = [
  ...BASE_VARIABLES,
  'pets.lista',
  'agendamento.data',
  'agendamento.hora',
  'agendamento.servico',
  'agendamento.profissional',
] as const

export const MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
  {
    key: 'appointment_confirmed',
    category: 'TRANSACTIONAL',
    variables: APPOINTMENT_VARIABLES,
    subject: 'Agendamento confirmado no {{petshop.nome}}',
    body: {
      WHATSAPP:
        'Olá, {{tutor.primeiro_nome}}! Seu horário no {{petshop.nome}} está confirmado.\n\n' +
        '{{pets.lista}} — {{agendamento.servico}}\n' +
        '{{agendamento.data}} às {{agendamento.hora}}\n\n' +
        'Precisa remarcar? Fale com a gente pelo {{petshop.telefone}}.',
      EMAIL:
        'Olá, {{tutor.primeiro_nome}}!\n\n' +
        'Seu horário no {{petshop.nome}} está confirmado.\n\n' +
        'Pet: {{pets.lista}}\n' +
        'Serviço: {{agendamento.servico}}\n' +
        'Quando: {{agendamento.data}} às {{agendamento.hora}}\n' +
        'Profissional: {{agendamento.profissional}}\n\n' +
        'Precisa remarcar? Fale com a gente pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'appointment_reminder',
    category: 'TRANSACTIONAL',
    variables: APPOINTMENT_VARIABLES,
    subject: 'Lembrete: {{pets.lista}} tem horário amanhã',
    body: {
      WHATSAPP:
        'Oi, {{tutor.primeiro_nome}}! Passando para lembrar do horário de {{pets.lista}} ' +
        'no {{petshop.nome}}.\n\n' +
        '{{agendamento.servico}}\n' +
        '{{agendamento.data}} às {{agendamento.hora}}\n\n' +
        'Se precisar cancelar, avise pelo {{petshop.telefone}}.',
      EMAIL:
        'Oi, {{tutor.primeiro_nome}}!\n\n' +
        'Passando para lembrar do horário de {{pets.lista}} no {{petshop.nome}}.\n\n' +
        'Serviço: {{agendamento.servico}}\n' +
        'Quando: {{agendamento.data}} às {{agendamento.hora}}\n\n' +
        'Se precisar cancelar, avise pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'appointment_cancelled',
    category: 'TRANSACTIONAL',
    variables: APPOINTMENT_VARIABLES,
    subject: 'Agendamento cancelado no {{petshop.nome}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, o horário de {{pets.lista}} em {{agendamento.data}} ' +
        'às {{agendamento.hora}} foi cancelado.\n\n' +
        'Quando quiser remarcar, é só chamar no {{petshop.telefone}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'O horário de {{pets.lista}} em {{agendamento.data}} às {{agendamento.hora}} ' +
        'foi cancelado.\n\n' +
        'Quando quiser remarcar, é só chamar no {{petshop.telefone}}.',
    },
  },
  {
    key: 'service_done',
    category: 'TRANSACTIONAL',
    variables: [...BASE_VARIABLES, 'pets.lista', 'agendamento.servico'],
    subject: '{{pets.lista}} está pronto(a)',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, {{pets.lista}} já está pronto(a) e esperando por você ' +
        'no {{petshop.nome}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        '{{pets.lista}} já está pronto(a) e esperando por você no {{petshop.nome}}.\n\n' +
        'Serviço: {{agendamento.servico}}',
    },
  },
]

const BY_KEY = new Map(MESSAGE_TEMPLATES.map((template) => [template.key, template]))

export function findTemplateDefinition(key: string): MessageTemplateDefinition | undefined {
  return BY_KEY.get(key)
}

export const MESSAGE_TEMPLATE_KEYS = MESSAGE_TEMPLATES.map((template) => template.key)

/**
 * Todo par `{{ns.campo}}` de um corpo. Usado tanto para validar o que o petshop
 * escreveu quanto para saber o que renderizar.
 */
export function extractVariables(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g)) {
    found.add(match[1]!)
  }
  return [...found]
}
