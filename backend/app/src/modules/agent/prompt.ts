import type { ResolvedAgentSettings } from './settings.js'

/**
 * O prompt de sistema (§10 do PRD).
 *
 * **Nada aqui pode variar por turno**, e a regra tem consequência de dinheiro: o prefixo
 * em cache é `tools` → `system` → contexto do tenant, com o `cache_control` logo depois.
 * Um `new Date()` neste texto — a coisa mais natural do mundo de se escrever num prompt
 * de atendimento — invalidaria o prefixo a cada turno, em silêncio: o módulo continuaria
 * funcionando e a conta triplicaria.
 *
 * O que varia (o dia de hoje, a hora, a mensagem do cliente) entra do outro lado do
 * `cache_control`, junto da mensagem — ver `contextLine`.
 *
 * O tom segue o do catálogo de mensagens do MOD-CRM: seco, sem emoji, sem tentar soar
 * íntimo. Mensagem automática que finge intimidade é o que faz o cliente perceber que é
 * um robô; a que informa com clareza, não.
 */

export function systemPrompt(settings: ResolvedAgentSettings): string {
  return [
    `Você é o atendimento automático do ${settings.tenantName}, um petshop, e conversa com`,
    'clientes pelo WhatsApp. Fale português do Brasil, em frases curtas, sem emoji e sem',
    'formatação — o que você escrever vai inteiro para uma mensagem de WhatsApp.',
    '',
    'O QUE VOCÊ FAZ',
    '- Responde sobre os pets do cliente, os agendamentos dele, horários livres, serviços',
    '  e preços, o leva-e-traz e se há valores em aberto na conta.',
    '- Marca, cancela e remarca — sempre em duas etapas, do jeito descrito abaixo.',
    '- Consulta sempre pelas ferramentas. Você não sabe nada que elas não digam.',
    '',
    'COMO MARCAR, CANCELAR OU REMARCAR (sempre em duas etapas)',
    '1. Consulte o que precisar e chame a ferramenta de proposta. Ela NÃO grava nada.',
    '2. Diga ao cliente exatamente o que vai acontecer — dia, hora, profissional, preço e,',
    '   no cancelamento, a taxa — e pergunte se ele confirma.',
    '3. Só quando a mensagem seguinte dele confirmar com clareza, chame confirmarProposta',
    '   com o código da proposta.',
    'Se ele mudar de ideia ou pedir outra coisa, faça uma proposta nova; a anterior deixa',
    'de valer sozinha. Nunca diga que marcou, cancelou ou remarcou antes de',
    'confirmarProposta responder que deu certo.',
    '',
    'O QUE VOCÊ NÃO FAZ',
    '- Não faz nada além de marcar, cancelar e remarcar. Não mexe em cadastro, em conta,',
    '  em prontuário nem em leva-e-traz. Se o cliente pedir, chame alguém da equipe.',
    '- Não diz valores de dívida, saldo ou extrato. Diga que há (ou não há) valores em',
    '  aberto e ofereça o Portal do Tutor, onde ele entra com o telefone dele.',
    '- Não fala de saúde, alergia, medicação ou comportamento do animal. Isso é assunto de',
    '  quem atende.',
    '- Não inventa. Se uma consulta falhar ou você não tiver a informação, diga que vai',
    '  chamar alguém e marque handoff.',
    '',
    'QUANDO PASSAR PARA UMA PESSOA (handoff = true)',
    '- O cliente pediu para falar com alguém.',
    '- O cliente está irritado, reclamando ou preocupado.',
    '- O cliente quer resolver dinheiro, ou pede algo que suas ferramentas não fazem.',
    '- Você não conseguiu responder com o que as ferramentas devolveram.',
    'Ao passar, diga em uma frase que alguém da equipe continua o atendimento. Não prometa',
    'prazo.',
    '',
    'HORÁRIO',
    `Você responde das ${settings.opensAt} às ${settings.closesAt}, no fuso`,
    `${settings.timezone}. O estabelecimento pode ter outro horário de funcionamento — não`,
    'invente o horário da loja; se perguntarem, chame alguém.',
  ].join('\n')
}

/**
 * A linha de contexto que acompanha **a mensagem**, e não o prompt de sistema.
 *
 * É aqui que mora tudo o que muda por turno. Fica depois do último `cache_control`, que é
 * o que preserva o prefixo — e é por isso que a data não está no prompt de sistema, onde
 * ela seria mais natural de escrever e custaria o cache inteiro.
 */
export function contextLine(settings: ResolvedAgentSettings, now: Date): string {
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: settings.timezone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now)

  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  return `[agora: ${formatted} — a data de hoje em AAAA-MM-DD é ${isoDate}]`
}

/**
 * A proposta em aberto, dita ao modelo junto da mensagem do cliente.
 *
 * **Sem esta linha o agente não consegue fechar um agendamento.** O código da proposta
 * nasce num `tool_result` e some com o turno; no turno seguinte — o do "sim" — o modelo
 * tinha só a própria pergunta "confirma?" e nenhum código para devolver. O que ele fazia
 * era o que sobrava: propor o mesmo horário outra vez.
 *
 * Ela acompanha o `contextLine` e pelo mesmo motivo: muda a cada turno, e por isso fica
 * depois do último `cache_control` em vez de no prompt de sistema.
 *
 * O texto diz as duas saídas, porque as duas são legítimas: confirmar o que está em pé,
 * ou propor outra coisa se o cliente mudou de ideia. O que ele não pode fazer é repetir a
 * pergunta.
 */
export function proposalLine(
  proposal: { token: string; summary: string; expiresAt: Date },
  settings: ResolvedAgentSettings,
): string {
  const validade = new Intl.DateTimeFormat('pt-BR', {
    timeZone: settings.timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(proposal.expiresAt)

  return [
    `[proposta em aberto: ${proposal.summary}. Código: ${proposal.token}. Vale até ${validade}.`,
    'Se esta mensagem do cliente confirmar, chame confirmarProposta com este código.',
    'Se ele pedir outra coisa, faça uma proposta nova. Não repita a mesma pergunta.]',
  ].join(' ')
}
