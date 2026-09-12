import { getMaintenancePrisma } from '@petshop/db'
import type { PlatformHealth } from '@petshop/shared-types'
import { platformHealth } from './health.js'

/**
 * O catálogo de regras de alerta (MOD-ADMIN-06).
 *
 * **Regra é código, não configuração de banco.** Uma tabela de regras com operador e
 * limiar pareceria mais flexível e não seria: cada regra deste catálogo consulta uma
 * fonte diferente — a fila de saída, o histórico de jobs, as sondas de dependência — e um
 * campo `metric > valor` só saberia falar com a série. O que a tabela ganharia em
 * configuração perderia em alcance, e o que a equipe quer mudar de verdade (o limiar) é
 * uma linha aqui.
 *
 * Cinco regras, e a lista é curta de propósito: **alerta que acende sem que ninguém
 * saiba o que fazer treina a equipe a ignorar o painel**. Cada uma destas tem uma ação
 * correspondente — destravar a fila, olhar o job, subir a dependência, desempatar duas
 * contas do Clerk com o mesmo e-mail.
 */

export interface AlertBreach {
  /** Nulo quando a regra é da plataforma, e não de um estabelecimento. */
  tenantId: string | null
  /** O número medido: profundidade da fila, quantidade de jobs falhando. */
  value: number
  /** O que a notificação diz além do número — quais jobs, qual dependência. */
  detail?: string
}

export interface AlertRule {
  key: string
  /** A frase que a tela e o e-mail mostram. O código sozinho não se lê. */
  label: string
  /** O que fazer a respeito. Vai no corpo do e-mail, e é metade do valor do alarme. */
  action: string
  evaluate(now: Date): Promise<AlertBreach[]>
}

/** Uma mensagem parada há mais que isto não está esperando: está presa. */
const QUEUE_STUCK_MINUTES = 15

/**
 * A janela de falha do webhook do Clerk.
 *
 * Vinte e quatro horas, e não a última avaliação: a colisão de e-mail não se resolve
 * sozinha, e um alarme que apaga na próxima rodada esconderia justamente o caso que
 * espera por intervenção humana.
 */
const CLERK_WEBHOOK_WINDOW_HOURS = 24

/**
 * O painel de saúde, uma vez por avaliação.
 *
 * Três das cinco regras olham para o mesmo retrato — jobs falhando, jobs parados,
 * dependência fora. Sem esta memória, uma avaliação dispararia três rodadas de sondas, e
 * as sondas são a única parte do painel que sai do processo. O cache de quinze segundos do
 * `platformHealth` cobriria isso **quando há Redis**; em instalação sem cache, não cobre —
 * e alarme não pode custar mais caro justamente na instalação mais simples.
 *
 * A chave é o instante da avaliação, que o agendador passa igual às três regras.
 */
let memoria: { chave: number; health: Promise<PlatformHealth> } | null = null

function healthForRun(now: Date): Promise<PlatformHealth> {
  const chave = now.getTime()
  if (memoria?.chave !== chave) memoria = { chave, health: platformHealth() }
  return memoria.health
}

/** Os cinco primeiros de uma lista longa; o resto vira contagem (AC-04). */
export function firstFive(items: string[]): string {
  const mostrados = items.slice(0, 5).join(', ')
  return items.length > 5 ? `${mostrados} e mais ${items.length - 5}` : mostrados
}

export const ALERT_RULES: AlertRule[] = [
  {
    key: 'message_queue_stuck',
    label: 'Mensagens presas na fila de saída',
    action:
      'Confira o painel de saúde: fila parada costuma ser provedor fora do ar, WhatsApp desconectado ou o job de despacho travado.',
    /**
     * A regra do exemplo do PRD, e a única por estabelecimento.
     *
     * Parada é `QUEUED` ou `SENDING` há mais de quinze minutos. `SENDING` entra porque é o
     * estado em que a mensagem fica quando o processo morreu no meio do envio — ela não
     * volta sozinha, e sem esta linha ninguém descobre.
     */
    async evaluate(now) {
      const corte = new Date(now.getTime() - QUEUE_STUCK_MINUTES * 60_000)

      const rows = await getMaintenancePrisma().message.groupBy({
        by: ['tenantId'],
        where: { status: { in: ['QUEUED', 'SENDING'] }, createdAt: { lt: corte } },
        _count: { _all: true },
      })

      return rows.map((row) => ({ tenantId: row.tenantId, value: row._count._all }))
    },
  },

  {
    key: 'job_failing',
    label: 'Job falhando',
    action: 'Veja o erro da última execução no painel de saúde e no log do processo.',
    /**
     * Um alerta por regra, e não por job.
     *
     * A chave de um alerta é `(regra, tenant)`, e job não tem tenant — trinta jobs falhando
     * viraram trinta linhas idênticas na mesma chave. O que a linha carrega é a **contagem**
     * e os cinco primeiros nomes; o detalhe de cada um continua no painel de saúde, que é
     * onde alguém vai olhar depois de receber o aviso.
     */
    async evaluate(now) {
      const health = await healthForRun(now)
      const falhando = health.jobs.filter((job) => job.state === 'FAILING').map((job) => job.name)
      if (falhando.length === 0) return []
      return [{ tenantId: null, value: falhando.length, detail: firstFive(falhando) }]
    },
  },

  {
    key: 'job_stale',
    label: 'Job parado',
    action:
      'O job não conclui com sucesso há mais de três vezes o intervalo dele. Verifique o lease preso e se o agendador está no ar.',
    async evaluate(now) {
      const health = await healthForRun(now)
      const parados = health.jobs.filter((job) => job.state === 'STALE').map((job) => job.name)
      if (parados.length === 0) return []
      return [{ tenantId: null, value: parados.length, detail: firstFive(parados) }]
    },
  },

  {
    key: 'dependency_down',
    label: 'Dependência fora do ar',
    action: 'Postgres, Redis, RabbitMQ ou Gotenberg não respondeu à sonda do painel de saúde.',
    /**
     * `DISABLED` não entra, e a distinção é a mesma do painel: dependência desligada por
     * configuração é decisão, não falha. Alarmar por ela em instalação mínima seria o
     * caminho mais curto para a equipe filtrar estes e-mails.
     */
    async evaluate(now) {
      const health = await healthForRun(now)
      const fora = health.dependencies
        .filter((dependency) => dependency.state === 'DOWN')
        .map((dependency) => dependency.name)
      if (fora.length === 0) return []
      return [{ tenantId: null, value: fora.length, detail: firstFive(fora) }]
    },
  },

  {
    key: 'clerk_webhook_failing',
    label: 'Sincronização com o Clerk falhando',
    action:
      'Veja `webhook_events` com status FAILED: o caso previsto é a colisão de e-mail da RN-12, em que duas contas do Clerk apontam para o mesmo endereço. Só sai à mão, escolhendo a dona legítima.',
    /**
     * A regra existe porque o webhook **não** devolve erro ao Clerk nesse caso (MOD-IDENT-03).
     *
     * Insistir faria o provedor reentregar para sempre um conflito que nenhuma reentrega
     * resolve, então o evento fica gravado como `FAILED` e responde 204. Sem esta regra a
     * linha ficaria no banco sem leitor, e o espelho do usuário pararia de atualizar em
     * silêncio — que é exatamente o sintoma que o MOD-IDENT-03 veio acabar.
     */
    async evaluate(now) {
      const desde = new Date(now.getTime() - CLERK_WEBHOOK_WINDOW_HOURS * 60 * 60 * 1000)
      const falhas = await getMaintenancePrisma().webhookEvent.count({
        where: { provider: 'clerk', status: 'FAILED', receivedAt: { gte: desde } },
      })
      if (falhas === 0) return []
      return [{ tenantId: null, value: falhas }]
    },
  },
]

export function ruleByKey(key: string): AlertRule | undefined {
  return ALERT_RULES.find((rule) => rule.key === key)
}
