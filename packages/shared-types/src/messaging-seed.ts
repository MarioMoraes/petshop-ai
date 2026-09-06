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

/**
 * As da régua de cobrança. `financeiro.valor_devido` já vem formatado em reais pelo
 * chamador — o template não faz conta, e um número em centavos escapando para o corpo
 * da mensagem é o erro mais caro que este catálogo pode cometer.
 */
const DUNNING_VARIABLES = [
  ...BASE_VARIABLES,
  'financeiro.valor_devido',
  'financeiro.dias_atraso',
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
  {
    key: 'portal_codigo_acesso',
    label: 'Código de acesso ao Portal',
    /**
     * `OPERATIONAL`, e não `TRANSACTIONAL` como o PRD portal_tutor_09 §3 escreveu.
     *
     * O PRD supôs que TRANSACTIONAL ignora a janela de silêncio; quem a ignora, em
     * `window.ts`, é **OPERATIONAL**. Um código pedido às 23h sairia às 8h da manhã
     * seguinte, sete horas depois de expirar — e o tutor ficaria olhando para uma tela
     * de "enviamos o código" que nunca cumpre a promessa.
     */
    category: 'OPERATIONAL',
    variables: [...BASE_VARIABLES, 'portal.codigo'],
    subject: 'Seu código de acesso: {{portal.codigo}}',
    body: {
      WHATSAPP:
        '{{portal.codigo}} é o seu código de acesso ao Portal do {{petshop.nome}}.\n\n' +
        'Ele vale por 10 minutos. Não compartilhe com ninguém.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Seu código de acesso ao Portal do {{petshop.nome}} é {{portal.codigo}}.\n\n' +
        'Ele vale por 10 minutos. Se não foi você quem pediu, ignore esta mensagem.',
    },
  },
  {
    key: 'portal_boas_vindas',
    label: 'Boas-vindas ao Portal',
    category: 'TRANSACTIONAL',
    variables: [...BASE_VARIABLES, 'portal.link'],
    subject: 'Seu acesso ao Portal do {{petshop.nome}} está pronto',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, seu acesso ao Portal do {{petshop.nome}} está pronto.\n\n' +
        'Por ele você vê os seus pets, o histórico e a sua conta: {{portal.link}}',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Seu acesso ao Portal do {{petshop.nome}} está pronto. Por ele você acompanha ' +
        'os seus pets, o histórico de atendimentos e a sua conta.\n\n' +
        '{{portal.link}}',
    },
  },
  {
    key: 'portal_codigo_contato',
    label: 'Código para confirmar contato novo',
    /** `OPERATIONAL` pelo mesmo motivo do código de acesso: dez minutos não esperam a manhã. */
    category: 'OPERATIONAL',
    variables: [...BASE_VARIABLES, 'portal.codigo'],
    subject: 'Confirme este contato: {{portal.codigo}}',
    /**
     * **O texto diz o que está acontecendo, e não "bem-vindo de volta".**
     *
     * Este código sai para um endereço que ainda não está em ficha nenhuma, e quem o
     * recebe pode ser alguém que nunca ouviu falar do petshop — um dígito trocado basta.
     * Para essa pessoa, "seu código de acesso" é um susto sem explicação; saber que
     * alguém tentou cadastrar o contato dela, e que ignorar encerra o assunto, é o que
     * transforma a mensagem em aviso em vez de isca.
     */
    body: {
      WHATSAPP:
        '{{portal.codigo}} é o código para confirmar este contato no {{petshop.nome}}.\n\n' +
        'Ele vale por 10 minutos. Se não foi você quem pediu, ignore esta mensagem — ' +
        'sem o código nada é alterado.',
      EMAIL:
        'Alguém pediu para usar este e-mail no cadastro do {{petshop.nome}}.\n\n' +
        'Para confirmar, use o código {{portal.codigo}}. Ele vale por 10 minutos.\n\n' +
        'Se não foi você, ignore esta mensagem: sem o código nada é alterado.',
    },
  },

  /**
   * Os de MARKETING — os primeiros do catálogo (fatia 3 do MOD-CRM).
   *
   * Até aqui todo texto era execução de contrato: lembrete, confirmação, taxi, código.
   * Estes quatro exigem consentimento vigente para o canal, contam no teto diário do
   * tenant e no teto semanal do tutor, e não saem no domingo enquanto
   * `marketing_weekdays_only` for verdadeiro. É a categoria que decide tudo isso, não o
   * texto — e é por isso que ela está aqui e não numa configuração à parte.
   */
  {
    key: 'birthday_pet',
    label: 'Aniversário do pet',
    category: 'MARKETING',
    variables: [...BASE_VARIABLES, 'pet.nome'],
    subject: 'Feliz aniversário, {{pet.nome}}',
    /**
     * **A mensagem não leva benefício nenhum.**
     *
     * Foi decisão do dono do produto (questão 1 do §11 do PRD), e ela é o que mantém o
     * texto honesto: não existe cupom no sistema, e o MOD-LEDGER tem crédito e pacote —
     * nenhum dos dois é desconto condicional. Prometer aqui um "presente" que a
     * recepção teria de improvisar no balcão transforma a felicitação em constrangimento
     * para quem atende.
     */
    body: {
      WHATSAPP:
        'Hoje é aniversário do {{pet.nome}}. Toda a equipe do {{petshop.nome}} deseja um ' +
        'dia muito feliz.\n\n' +
        'Se quiser comemorar com um banho, fale com a gente pelo {{petshop.telefone}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Hoje é aniversário do {{pet.nome}}. Toda a equipe do {{petshop.nome}} deseja um ' +
        'dia muito feliz para ele e para você.\n\n' +
        'Se quiser comemorar com um banho, fale com a gente pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'birthday_tutor',
    label: 'Aniversário do tutor',
    category: 'MARKETING',
    /**
     * **Sem `pets.lista`, de propósito.**
     *
     * A primeira redação citava os pets, e ela quebra em dois casos que não são raros:
     * o tutor que ainda não cadastrou nenhum e o que perdeu o único. A variável
     * renderizaria vazio e a frase sairia como "a equipe — e o — deseja", ou pior,
     * lembraria a pessoa da ausência no dia do aniversário dela.
     */
    variables: BASE_VARIABLES,
    subject: 'Feliz aniversário, {{tutor.primeiro_nome}}',
    body: {
      WHATSAPP:
        'Feliz aniversário, {{tutor.primeiro_nome}}. A equipe do {{petshop.nome}} deseja ' +
        'um ótimo dia.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Feliz aniversário. A equipe do {{petshop.nome}} deseja um ótimo dia para você.',
    },
  },
  {
    key: 'winback',
    label: 'Convite de volta',
    category: 'MARKETING',
    variables: [...BASE_VARIABLES, 'pets.lista'],
    subject: 'Sentimos falta do {{pets.lista}}',
    /**
     * O texto **não pergunta por que sumiu**. Quem não volta há três meses trocou de
     * petshop, se mudou ou perdeu o pet — e a única dessas três respostas que a
     * mensagem pode provocar sem custo é nenhuma delas.
     */
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, faz um tempo que o {{pets.lista}} não aparece por aqui.\n\n' +
        'A porta do {{petshop.nome}} continua aberta. Para marcar um horário, fale com a ' +
        'gente pelo {{petshop.telefone}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Faz um tempo que o {{pets.lista}} não aparece por aqui, e a gente queria dizer ' +
        'que a porta do {{petshop.nome}} continua aberta.\n\n' +
        'Para marcar um horário, fale com a gente pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'campaign_broadcast',
    label: 'Campanha (texto livre)',
    category: 'MARKETING',
    variables: [...BASE_VARIABLES, 'pets.lista'],
    subject: 'Recado do {{petshop.nome}}',
    /**
     * O único template do catálogo que **espera ser reescrito**.
     *
     * A campanha manual (MOD-CRM-12) precisa de um texto por disparo, e o modelo de
     * templates é por chave, não por campanha. O padrão aqui é um recado genérico o
     * bastante para não envergonhar quem esquecer de trocá-lo, e vazio o bastante para
     * ninguém confundi-lo com uma mensagem pronta.
     */
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, temos uma novidade no {{petshop.nome}}.\n\n' +
        'Fale com a gente pelo {{petshop.telefone}} para saber mais.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Temos uma novidade no {{petshop.nome}}. Fale com a gente pelo ' +
        '{{petshop.telefone}} para saber mais.',
    },
  },

  /**
   * Os três degraus da régua (MOD-CRM-08).
   *
   * `TRANSACTIONAL`, e não `MARKETING`: cobrar dívida é execução de contrato, e exigir
   * consentimento de marketing para avisar alguém do próprio débito faria o
   * inadimplente que revogou promoções ficar invisível para a cobrança.
   *
   * Nenhum dos três tem **link de pagamento**, e é decisão de produto, não esquecimento:
   * a v1 não tem gateway (decisão 5 do dossiê), e o pagamento é registrado à mão no
   * balcão. Prometer um link que não existe é o caminho mais rápido para o tutor achar
   * que a mensagem é golpe.
   */
  {
    key: 'dunning_soft',
    label: 'Cobrança — primeiro aviso',
    category: 'TRANSACTIONAL',
    variables: DUNNING_VARIABLES,
    subject: 'Você tem um valor em aberto no {{petshop.nome}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, consta um valor em aberto de {{financeiro.valor_devido}} ' +
        'na sua conta do {{petshop.nome}}.\n\n' +
        'Se já tiver pago, é só ignorar. Para regularizar, fale com a gente pelo ' +
        '{{petshop.telefone}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'Consta um valor em aberto de {{financeiro.valor_devido}} na sua conta do ' +
        '{{petshop.nome}}.\n\n' +
        'Se já tiver pago, é só ignorar esta mensagem. Para regularizar, fale com a gente ' +
        'pelo {{petshop.telefone}}.',
    },
  },
  {
    key: 'dunning_firm',
    label: 'Cobrança — segundo aviso',
    category: 'TRANSACTIONAL',
    variables: DUNNING_VARIABLES,
    subject: 'Sobre o valor em aberto no {{petshop.nome}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, o valor de {{financeiro.valor_devido}} na sua conta do ' +
        '{{petshop.nome}} está em aberto há {{financeiro.dias_atraso}} dias.\n\n' +
        'Fale com a gente pelo {{petshop.telefone}} para combinarmos a melhor forma de ' +
        'regularizar.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'O valor de {{financeiro.valor_devido}} na sua conta do {{petshop.nome}} está em ' +
        'aberto há {{financeiro.dias_atraso}} dias.\n\n' +
        'Fale com a gente pelo {{petshop.telefone}} para combinarmos a melhor forma de ' +
        'regularizar.',
    },
  },
  {
    key: 'dunning_final',
    label: 'Cobrança — último aviso',
    category: 'TRANSACTIONAL',
    variables: DUNNING_VARIABLES,
    subject: 'Precisamos regularizar sua conta no {{petshop.nome}}',
    /**
     * O último degrau **não ameaça**. Não há protesto, negativação nem suspensão
     * automática neste sistema, e escrever o que não se vai fazer só ensina o cliente a
     * não levar a régua a sério na próxima vez.
     */
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, o valor de {{financeiro.valor_devido}} continua em ' +
        'aberto há {{financeiro.dias_atraso}} dias no {{petshop.nome}}.\n\n' +
        'Precisamos regularizar para seguir atendendo. Fale com a gente pelo ' +
        '{{petshop.telefone}}.',
      EMAIL:
        '{{tutor.primeiro_nome}},\n\n' +
        'O valor de {{financeiro.valor_devido}} continua em aberto há ' +
        '{{financeiro.dias_atraso}} dias no {{petshop.nome}}.\n\n' +
        'Precisamos regularizar para seguir atendendo. Fale com a gente pelo ' +
        '{{petshop.telefone}}.',
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
