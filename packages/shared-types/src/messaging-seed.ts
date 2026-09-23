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
  /**
   * A quem o texto se dirige (MOD-NOTIF-01). Padrão `TUTOR`, que preserva os dezessete
   * textos anteriores ao MOD-NOTIF sem tocá-los.
   *
   * Não é decoração: é o que impede a tela do CRM de oferecer ao petshop um texto de
   * boas-vindas de equipe para editar como se fosse recado de cliente, e o que separa
   * `{{tutor.nome}}` de `{{usuario.nome}}` na validação de variável.
   */
  audience?: 'TUTOR' | 'USER'
  /**
   * Quem escreve o texto, e portanto em que molde ele sai (MOD-NOTIF-04).
   *
   * `TENANT` é o padrão e é o catálogo inteiro de hoje: o petshop edita na tela do CRM,
   * escreve em texto puro, e o e-mail sai com o embrulho mínimo que só preserva as
   * quebras de linha. Um texto de WhatsApp dentro de moldura corporativa soa falso.
   *
   * `SYSTEM` é o texto que o **produto** escreve — boas-vindas, recibo, documento — e
   * ele sai no molde de marca, com logo, cor e rodapé do estabelecimento. Um molde só
   * para os dois casos pioraria um dos dois.
   */
  authored?: 'TENANT' | 'SYSTEM'
  /**
   * O aviso no aparelho do tutor, que vai **junto** com a mensagem (etapa 9 do app).
   *
   * A lista de avisos que viram push **é** este campo: template sem ele nunca chega à
   * tela bloqueada. Ficam de fora os códigos de acesso — seis dígitos na tela bloqueada
   * são credencial exposta a quem estiver ao lado —, a resposta do agente (a conversa é
   * no WhatsApp) e todo `MARKETING`, que pediria consentimento próprio.
   *
   * Texto do **produto**, e não do petshop: não aparece na tela do CRM. E é escrito
   * para a tela bloqueada — o que se lê ali sem desbloquear é lido por qualquer um,
   * então a cobrança diz que há algo em aberto e não quanto.
   *
   * `abre` é para onde o toque leva no app.
   */
  push?: { title: string; body: string; abre: 'agendamento' | 'conta' }
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

/**
 * As do documento entregue por e-mail (MOD-NOTIF-06 e 07).
 *
 * `documento.link` é a página "Meus Documentos" do Portal, **nunca** a URL assinada do
 * bucket — o motor a resolve no enfileiramento, e a razão está em `attachments.ts`.
 */
const DOCUMENT_VARIABLES = [
  ...BASE_VARIABLES,
  'pet.nome',
  'documento.tipo',
  'documento.numero',
  'documento.link',
  'financeiro.valor_pago',
] as const

/**
 * As dos textos dirigidos à **equipe** (MOD-NOTIF-08 e 09).
 *
 * `tutor.*` não aparece aqui, e é a diferença que dá sentido ao `audience`: quem recebe
 * não é cliente, e um texto de equipe que dissesse "Olá, tutor" seria o vazamento de
 * enquadramento que o módulo existe para evitar. Os três endereços são montados de
 * `APP_DOMAIN` em tempo de execução — nunca de constante cravada (AC-02 de MOD-NOTIF-08).
 */
const TEAM_VARIABLES = [
  'usuario.nome',
  'usuario.primeiro_nome',
  'petshop.nome',
  'petshop.telefone',
  'petshop.link_admin',
  'petshop.link_site',
  'petshop.link_portal',
  'equipe.papel',
] as const

/**
 * As variáveis dos avisos da **conta** — os que a PetShop AI manda ao administrador
 * sobre a assinatura dele, e não os que o petshop manda ao cliente dele.
 *
 * `equipe.papel` fica de fora: quem recebe cobrança é quem administra, e dizer o papel
 * de volta a essa pessoa não acrescenta nada. Entram, no lugar, os dois números que a
 * decisão exige — quanto tempo resta e onde se resolve.
 */
const ACCOUNT_VARIABLES = [
  'usuario.nome',
  'usuario.primeiro_nome',
  'petshop.nome',
  'petshop.link_admin',
  'conta.link_assinatura',
  'conta.link_pagamento',
  /**
   * O prazo **por extenso** — `em 3 dias`, `em 2 dias`, `amanhã` —, e não o número.
   *
   * Com o número, o texto tinha de trazer o substantivo de fora (`em {{n}} dias`) e saía
   * "em 1 dias" no último aviso, que é um em cada três. Quem monta o valor é quem sabe
   * quantos dias são; deixar a concordância com o molde é deixá-la com quem não sabe.
   */
  'conta.prazo',
  'conta.vence_em',
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
    push: {
      title: 'Horário confirmado',
      body: '{{pets.lista}} — {{agendamento.data}} às {{agendamento.hora}} no {{petshop.nome}}.',
      abre: 'agendamento',
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
    push: {
      title: 'Amanhã tem horário',
      body: '{{pets.lista}} — {{agendamento.data}} às {{agendamento.hora}} no {{petshop.nome}}.',
      abre: 'agendamento',
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
    push: {
      title: 'Horário cancelado',
      body: 'O horário de {{pets.lista}} em {{agendamento.data}} às {{agendamento.hora}} foi cancelado.',
      abre: 'agendamento',
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
    push: {
      title: '{{pets.lista}} está pronto(a)',
      body: 'Já pode buscar no {{petshop.nome}}.',
      abre: 'agendamento',
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
    push: {
      title: 'A van está a caminho',
      body: 'Saímos para buscar {{pets.lista}}. Previsão: {{taxi.janela}}.',
      abre: 'agendamento',
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
    push: {
      title: 'A van chegou',
      body: 'Estamos na porta para buscar {{pets.lista}}.',
      abre: 'agendamento',
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
        '{{tutor.primeiro_nome}},\n\n' + '{{pets.lista}} já está em casa. Obrigado pela confiança!',
    },
    push: {
      title: '{{pets.lista}} chegou em casa',
      body: 'Até a próxima!',
      abre: 'agendamento',
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
    push: {
      title: 'Não conseguimos buscar {{pets.lista}}',
      body: 'O horário continua de pé. Toque para ver o que fazer.',
      abre: 'agendamento',
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
  /**
   * A resposta que a recepção escreve pela tela (AC-03 de MOD-AI-06).
   *
   * **O único texto do catálogo que não tem texto.** O corpo é a variável e nada mais:
   * quem o escreve é a atendente, palavra por palavra, respondendo a um cliente que
   * mandou mensagem primeiro. O template existe porque o motor do MOD-NOTIF é a única
   * porta de saída do produto (RN-15) e ele pede uma chave — e porque é o que faz a
   * resposta entrar no mesmo histórico, no mesmo teto de vazão e na mesma fila de tudo
   * o mais que o petshop manda.
   *
   * `SYSTEM` para ficar **fora da tela de textos**: editá-lo não configuraria nada,
   * só quebraria a resposta de todo mundo. `OPERATIONAL` porque responder a quem
   * escreveu não é campanha nem cobrança — e é a categoria que atravessa a janela de
   * silêncio, que é o que se espera de quem responde às dez da noite a um cliente que
   * acabou de escrever.
   */
  {
    key: 'agent_reply',
    label: 'Resposta da recepção',
    category: 'OPERATIONAL',
    /**
     * **Com namespace, como todas as outras — e não por gosto.**
     *
     * O substituidor só reconhece `{{namespace.campo}}`: a expressão exige o ponto. Esta
     * variável nasceu como `mensagem`, sem ponto, e por isso **nunca era substituída** —
     * o cliente recebia no WhatsApp o texto `{{mensagem}}`, literal, no lugar da resposta
     * do agente. Não havia erro em lugar nenhum: a mensagem saía, era entregue, e só quem
     * estava do outro lado via o defeito.
     */
    variables: [...BASE_VARIABLES, 'atendimento.mensagem'],
    subject: 'Resposta do {{petshop.nome}}',
    authored: 'SYSTEM',
    body: {
      WHATSAPP: '{{atendimento.mensagem}}',
      EMAIL: '{{atendimento.mensagem}}',
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
    push: {
      title: 'Sua conta no {{petshop.nome}}',
      body: 'Há um valor em aberto. Toque para ver.',
      abre: 'conta',
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
    push: {
      title: 'Sua conta no {{petshop.nome}}',
      body: 'Há um valor em aberto. Toque para ver.',
      abre: 'conta',
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
    push: {
      title: 'Sua conta no {{petshop.nome}}',
      body: 'Há um valor em aberto. Toque para ver.',
      abre: 'conta',
    },
  },

  // ─── MOD-NOTIF — os textos que o produto escreve ──────────────────────────
  //
  // Os quatro são `authored: 'SYSTEM'` e saem no molde de marca. Os dois primeiros vão
  // ao cliente e carregam papel; os dois últimos vão à equipe e não carregam nada além
  // de um endereço para entrar.

  {
    key: 'receipt_issued',
    label: 'Recibo emitido',
    category: 'TRANSACTIONAL',
    variables: DOCUMENT_VARIABLES,
    authored: 'SYSTEM',
    subject: 'Seu recibo do {{petshop.nome}}',
    body: {
      /**
       * O WhatsApp leva **link**, sempre (RN-06). Arquivo pela Evolution cai nas regras
       * de mídia, engorda a fila e some do histórico do tutor.
       */
      WHATSAPP:
        '{{tutor.primeiro_nome}}, seu recibo nº {{documento.numero}} do {{petshop.nome}} ' +
        'está pronto.\n\n' +
        'Valor: {{financeiro.valor_pago}}\n' +
        'Baixe em {{documento.link}}',
      EMAIL:
        'Olá, {{tutor.primeiro_nome}}!\n\n' +
        'Segue o recibo nº {{documento.numero}} referente ao seu pagamento de ' +
        '{{financeiro.valor_pago}} no {{petshop.nome}}.\n\n' +
        'O arquivo vai anexo. Ele também fica guardado em {{documento.link}}.',
    },
  },
  {
    key: 'document_issued',
    label: 'Documento emitido',
    category: 'TRANSACTIONAL',
    variables: DOCUMENT_VARIABLES,
    authored: 'SYSTEM',
    subject: '{{documento.tipo}} de {{pet.nome}}',
    body: {
      WHATSAPP:
        '{{tutor.primeiro_nome}}, o {{documento.tipo}} de {{pet.nome}} está pronto.\n\n' +
        'Baixe em {{documento.link}}',
      EMAIL:
        'Olá, {{tutor.primeiro_nome}}!\n\n' +
        'Segue o {{documento.tipo}} de {{pet.nome}}, emitido pelo {{petshop.nome}}.\n\n' +
        'O arquivo vai anexo. Ele também fica guardado em {{documento.link}}.',
    },
  },
  {
    key: 'tenant_welcome',
    label: 'Boas-vindas do estabelecimento',
    category: 'TRANSACTIONAL',
    variables: TEAM_VARIABLES,
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'Sua conta do {{petshop.nome}} está pronta',
    /**
     * Os três endereços de uma vez, e é deliberado: o admin que acabou de terminar o
     * wizard não sabe que existem três superfícies, e descobrir o site do próprio
     * petshop dias depois, por acaso, é o desperdício mais comum de um onboarding.
     */
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, a conta do {{petshop.nome}} está pronta.\n\n' +
        'Painel: {{petshop.link_admin}}\n' +
        'Site: {{petshop.link_site}}\n' +
        'Portal do cliente: {{petshop.link_portal}}',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}!\n\n' +
        'A conta do {{petshop.nome}} está pronta para uso. São três endereços, e vale ' +
        'conhecer os três:\n\n' +
        'O painel da equipe, onde você trabalha: {{petshop.link_admin}}\n' +
        'A página pública do seu petshop, que já está no ar: {{petshop.link_site}}\n' +
        'O portal onde seus clientes marcam horário: {{petshop.link_portal}}\n\n' +
        'Comece cadastrando um cliente e o pet dele. O resto do sistema nasce daí.',
    },
  },
  {
    key: 'user_welcome',
    label: 'Boas-vindas de membro da equipe',
    category: 'TRANSACTIONAL',
    variables: TEAM_VARIABLES,
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'Bem-vindo à equipe do {{petshop.nome}}',
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, seu acesso ao {{petshop.nome}} está ativo como ' +
        '{{equipe.papel}}.\n\nEntre em {{petshop.link_admin}}',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}!\n\n' +
        'Seu acesso ao {{petshop.nome}} está ativo, com o papel de {{equipe.papel}}.\n\n' +
        'O painel da equipe fica em {{petshop.link_admin}}.\n\n' +
        'O que você vê lá dentro depende do seu papel: se algo que você precisa não ' +
        'aparece, fale com quem administra a conta.',
    },
  },
  {
    key: 'support_access_requested',
    label: 'Pedido de acesso do suporte',
    /**
     * `TRANSACTIONAL`, e é o que o torna imune ao interruptor de marketing: um pedido de
     * acesso à base de clientes precisa chegar mesmo ao petshop que desligou tudo o mais.
     * Silenciá-lo transformaria o consentimento em acesso por decurso de prazo.
     */
    category: 'TRANSACTIONAL',
    variables: [...TEAM_VARIABLES, 'suporte.motivo', 'suporte.solicitante'],
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'Pedido de acesso da equipe {{petshop.nome}}',
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, o suporte pediu acesso de leitura aos dados do ' +
        '{{petshop.nome}}.\n\nMotivo: {{suporte.motivo}}\n\n' +
        'Aprove ou recuse em {{petshop.link_admin}}. Sem a sua aprovação, ninguém entra.',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}.\n\n' +
        '{{suporte.solicitante}}, da equipe PetShop AI, pediu acesso **de leitura** aos ' +
        'dados do {{petshop.nome}}.\n\n' +
        'Motivo informado: {{suporte.motivo}}\n\n' +
        'Nada é acessado sem a sua aprovação, o acesso tem prazo, é somente de leitura e ' +
        'toda consulta fica registrada na sua trilha de auditoria. Você pode revogar a ' +
        'qualquer momento.\n\n' +
        'Para decidir: {{petshop.link_admin}}',
    },
  },

  // ─── Os avisos da conta ────────────────────────────────────────────────────
  //
  // Os três falam da assinatura do estabelecimento com a PetShop AI, e não do petshop
  // com o cliente dele. São `USER`, porque o destinatário é quem administra a conta, e
  // `TRANSACTIONAL`, porque aviso de cobrança não se desliga por interruptor de
  // marketing — quem não quiser receber cancela a assinatura, que é outra coisa.
  //
  // Nenhum deles cita valor. O preço muda por plano, por ciclo e por grandfathering, e o
  // número que vale é o da tela: escrevê-lo no e-mail é criar uma segunda fonte de
  // verdade que envelhece sozinha.

  {
    key: 'trial_ending',
    label: 'Teste terminando',
    category: 'TRANSACTIONAL',
    variables: ACCOUNT_VARIABLES,
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'Seu teste do {{petshop.nome}} termina {{conta.prazo}}',
    /**
     * O texto diz o que **continua** e o que **para**, nessa ordem.
     *
     * Quem lê um aviso de fim de teste está decidindo se confia os dados do próprio
     * negócio ao produto, e a primeira dúvida é sempre a mesma: "perco o que cadastrei?".
     * Respondê-la antes de pedir o pagamento é o que separa um aviso de uma ameaça.
     */
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, o teste do {{petshop.nome}} termina ' +
        '{{conta.prazo}} ({{conta.vence_em}}).\n\n' +
        'Seus dados continuam onde estão. Para seguir agendando e atendendo, escolha um ' +
        'plano em {{conta.link_assinatura}}',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}!\n\n' +
        'O período de teste do {{petshop.nome}} termina {{conta.prazo}}, ' +
        'no dia {{conta.vence_em}}.\n\n' +
        'Tudo o que você cadastrou continua lá — clientes, pets, histórico e agenda. O que ' +
        'muda sem uma assinatura é que a conta passa a só leitura: dá para consultar, mas ' +
        'não para marcar horário, registrar atendimento ou receber pagamento.\n\n' +
        'Para escolher um plano: {{conta.link_assinatura}}\n\n' +
        'Se preferir conversar antes de decidir, é só responder a este e-mail.',
    },
  },
  {
    key: 'subscription_past_due',
    label: 'Mensalidade em atraso',
    category: 'TRANSACTIONAL',
    variables: ACCOUNT_VARIABLES,
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'A mensalidade do {{petshop.nome}} venceu',
    /**
     * Manda o link da cobrança em aberto, e não a tela de assinar: quem já assinou não
     * precisa escolher plano de novo, precisa pagar aquela cobrança. Mandar para a
     * escolha é a forma mais comum de transformar um atraso de três dias num
     * cancelamento.
     */
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, a mensalidade do {{petshop.nome}} venceu e ainda não ' +
        'consta como paga.\n\n' +
        'O petshop continua funcionando normalmente até {{conta.vence_em}}.\n\n' +
        'Pague em {{conta.link_pagamento}}',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}.\n\n' +
        'A mensalidade do {{petshop.nome}} venceu e ainda não consta como paga. Pode ser ' +
        'só o prazo de compensação — se você já pagou, ignore este e-mail.\n\n' +
        'Até {{conta.vence_em}} nada muda: a equipe trabalha normalmente, o site e o portal ' +
        'seguem no ar. Depois dessa data a conta passa a só leitura até o pagamento ser ' +
        'confirmado, e nenhum dado é apagado em momento nenhum.\n\n' +
        'Para pagar agora: {{conta.link_pagamento}}\n\n' +
        'Se houver algo errado com a cobrança, responda a este e-mail.',
    },
  },
  {
    key: 'tenant_suspended',
    label: 'Conta suspensa',
    category: 'TRANSACTIONAL',
    variables: ACCOUNT_VARIABLES,
    audience: 'USER',
    authored: 'SYSTEM',
    subject: 'A conta do {{petshop.nome}} está suspensa',
    /**
     * O único dos três que precisa dizer o que o cliente **final** está vendo: o site e o
     * portal saíram do ar, e o petshop descobrir isso por um cliente reclamando é pior do
     * que ler aqui.
     */
    body: {
      WHATSAPP:
        '{{usuario.primeiro_nome}}, a conta do {{petshop.nome}} foi suspensa por falta de ' +
        'pagamento.\n\n' +
        'Os dados estão guardados. Regularize em {{conta.link_pagamento}}',
      EMAIL:
        'Olá, {{usuario.primeiro_nome}}.\n\n' +
        'A conta do {{petshop.nome}} foi suspensa por falta de pagamento, depois do prazo ' +
        'de tolerância.\n\n' +
        'O que isso significa hoje: a equipe entra e consulta tudo o que já foi registrado, ' +
        'mas não grava nada novo; o site e o portal do cliente saem do ar; e as mensagens ' +
        'automáticas para os seus clientes deixam de sair.\n\n' +
        'Nenhum dado foi apagado, e o pagamento confirmado devolve tudo ao normal em ' +
        'minutos.\n\n' +
        'Para regularizar: {{conta.link_pagamento}}',
    },
  },
]

const BY_KEY = new Map(MESSAGE_TEMPLATES.map((template) => [template.key, template]))

export function findTemplateDefinition(key: string): MessageTemplateDefinition | undefined {
  return BY_KEY.get(key)
}

export const MESSAGE_TEMPLATE_KEYS = MESSAGE_TEMPLATES.map((template) => template.key)

/**
 * A quem o texto se dirige, com o padrão aplicado.
 *
 * Existe como função e não como leitura direta do campo porque o padrão é o caso
 * esmagador: dezoito dos vinte e dois textos omitem `audience`, e obrigar cada chamador
 * a escrever `?? 'TUTOR'` é convidar o primeiro que esquecer a mandar recado de equipe
 * para um cliente.
 */
export function templateAudienceOf(key: string): 'TUTOR' | 'USER' {
  return BY_KEY.get(key)?.audience ?? 'TUTOR'
}

/**
 * Em que molde o texto sai (MOD-NOTIF-04). Mesma razão da função acima.
 *
 * `TENANT` é texto do petshop e sai como sempre saiu; `SYSTEM` é texto do produto e sai
 * com logo, cor e rodapé. Quem pergunta é o despacho, no instante de montar o e-mail.
 */
export function templateAuthorOf(key: string): 'TENANT' | 'SYSTEM' {
  return BY_KEY.get(key)?.authored ?? 'TENANT'
}

/**
 * Os textos que o petshop pode editar na tela do CRM.
 *
 * Os de sistema ficam de fora: o corpo deles carrega o endereço do painel, o número do
 * documento e a estrutura que o molde de marca espera, e deixar o petshop reescrever
 * isso é deixá-lo quebrar o próprio e-mail de boas-vindas sem saber. Editar o **texto**
 * dele não é uma necessidade que alguém tenha declarado; editar o do lembrete, sim.
 */
export const EDITABLE_MESSAGE_TEMPLATES = MESSAGE_TEMPLATES.filter(
  (template) => (template.authored ?? 'TENANT') === 'TENANT',
)

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
