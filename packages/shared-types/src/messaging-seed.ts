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
  /**
   * Nome de tela. O painel de entregas lista uma coluna de template, e `service_done`
   * não diz nada a quem atende no balcão — "Serviço concluído", diz.
   */
  label: string
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

/**
 * As do Taxi Dog. `taxi.janela` é a promessa que o tutor precisa para estar em casa —
 * "entre 8h e 9h" —, e `taxi.motivo` só aparece no template de coleta frustrada.
 */
const TAXI_VARIABLES = [...BASE_VARIABLES, 'pets.lista', 'taxi.janela', 'taxi.motivo'] as const

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
    label: 'Agendamento confirmado',
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
    label: 'Lembrete de agendamento',
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
    label: 'Agendamento cancelado',
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
    label: 'Serviço concluído',
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

  // ─── Taxi Dog (MOD-CRM-09) ─────────────────────────────────────────────────
  //
  // Os quatro são **OPERATIONAL**, e essa é a única coisa que os separa dos demais:
  // atravessam a janela de silêncio (RN-04) e não contam para o teto diário. Um
  // motorista tocando a campainha às 7h30 é um fato sobre o pet, não uma promoção — e
  // um aviso que chega depois da campainha não avisou nada.
  {
    key: 'taxi_en_route',
    label: 'Taxi Dog a caminho',
    category: 'OPERATIONAL',
    variables: TAXI_VARIABLES,
    subject: 'Estamos a caminho para buscar {{pets.lista}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, saímos para buscar {{pets.lista}}. ' +
        'A previsão de chegada é {{taxi.janela}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Saímos para buscar {{pets.lista}}. A previsão de chegada é {{taxi.janela}}.\n\n' +
        'Qualquer coisa, fale com a gente pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'taxi_arrived',
    label: 'Taxi Dog chegou',
    category: 'OPERATIONAL',
    variables: TAXI_VARIABLES,
    subject: 'Chegamos para buscar {{pets.lista}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, chegamos no endereço para buscar {{pets.lista}}. ' +
        'Estamos esperando na porta.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Chegamos no endereço para buscar {{pets.lista}}. Estamos esperando na porta.',
    },
  },
  {
    key: 'taxi_delivered',
    label: 'Taxi Dog entregou',
    category: 'OPERATIONAL',
    variables: TAXI_VARIABLES,
    subject: '{{pets.lista}} chegou em casa',
    body: {
      WHATSAPP: '{{tutor.primeiro_nome}}, {{pets.lista}} já está em casa. Até a próxima!',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        '{{pets.lista}} já está em casa. Obrigado pela confiança!',
    },
  },
  {
    key: 'taxi_failed',
    label: 'Taxi Dog não conseguiu buscar',
    category: 'OPERATIONAL',
    variables: TAXI_VARIABLES,
    subject: 'Não conseguimos buscar {{pets.lista}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, passamos para buscar {{pets.lista}}, mas {{taxi.motivo}}.\n\n' +
        'O horário no {{petshop.nome}} continua de pé. Fale com a gente pelo ' +
        '{{petshop.telefone}} para combinarmos o que fazer.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Passamos para buscar {{pets.lista}}, mas {{taxi.motivo}}.\n\n' +
        'O horário no {{petshop.nome}} continua de pé. Fale com a gente pelo ' +
        '{{petshop.telefone}} para combinarmos o que fazer.',
    },
  },
]

const BY_KEY = new Map(MESSAGE_TEMPLATES.map((template) => [template.key, template]))

export function findTemplateDefinition(key: string): MessageTemplateDefinition | undefined {
  return BY_KEY.get(key)
}

export const MESSAGE_TEMPLATE_KEYS = MESSAGE_TEMPLATES.map((template) => template.key)

/**
 * Nome de tela do template, com o próprio `key` como último recurso.
 *
 * A mensagem guarda a chave que a originou, e uma chave pode sair do catálogo sem
 * sair do histórico — o painel precisa continuar mostrando a linha antiga, e mostrar
 * `dunning_step_2` é melhor do que mostrar um vazio.
 */
export function templateLabelOf(key: string): string {
  return BY_KEY.get(key)?.label ?? key
}

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
