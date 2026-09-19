import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  DEFAULT_TIMEZONE,
  PlanSchema,
  planIncludes,
  tenantOperates,
  type AgentSettings,
  type AgentTone,
  type UpdateAgentSettingsInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { assertFeature } from '../../shared/plan.js'
import {
  CACHE_KEYS,
  CACHE_TTL_SECONDS,
  cacheDelete,
  cacheGet,
  cacheSet,
} from '../../shared/redis.js'
import { loadSettings as loadMessagingSettings } from '../messaging/settings.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * A configuração do agente (MOD-AI-07).
 *
 * Como `taxi_settings` e `messaging_settings`, a linha só existe quando o petshop mexe —
 * sem linha, valem os padrões do banco. E `enabled` nasce **falso**: o cliente não é quem
 * deve descobrir que o petshop ligou um robô.
 *
 * **A janela é hora local do estabelecimento**, e não do servidor. O fuso sai de
 * `tenant_settings`, que é a mesma fonte do horário de silêncio das mensagens — dois
 * fusos no mesmo processo produziriam um agente que responde às 22h de um e às 19h do
 * outro.
 */

export interface ResolvedAgentSettings {
  enabled: boolean
  opensAt: string
  closesAt: string
  monthlyCapCents: number
  timezone: string
  /** O nome do estabelecimento, que vai no aviso de automação e no prompt. */
  tenantName: string
  /**
   * O nome com que o agente se apresenta, ou `null` para "o atendimento automático".
   *
   * **Entra no prompt de sistema, e pode**: é estável por tenant, como o nome da loja e
   * a janela. O que não pode entrar ali é o nome do **cliente**, que muda a cada conversa
   * — ver `contextLine` em `prompt.ts`.
   */
  personaName: string | null
  /** O registro da conversa (MOD-AI-07). Decide o bloco COMO VOCÊ FALA do prompt. */
  tone: AgentTone
  /** Sem motor de mensagens não há como responder — ver `canEnable`. */
  messagingEnabled: boolean
}

const DEFAULTS = {
  enabled: false,
  opensAt: '08:00',
  closesAt: '19:00',
  monthlyCapCents: 50_000,
  personaName: null,
  /**
   * `CORDIAL` e não `SOBRIO`, **inclusive para quem já tinha linha**.
   *
   * O default do banco é o mesmo, e é a mudança que a migration existe para fazer: o tom
   * seco era o comportamento de todo mundo, e quem o quiser de volta escolhe `SOBRIO` na
   * tela. Deixar o padrão no que existia manteria a humanização desligada para todos os
   * tenants que nunca abrirem a configuração — que são justamente os que mais precisam.
   */
  tone: 'CORDIAL',
} as const satisfies { tone: AgentTone; [key: string]: unknown }

export async function readSettings(
  tx: TenantTransaction,
  tenantId: string,
): Promise<ResolvedAgentSettings> {
  const [row, tenant, messaging] = await Promise.all([
    tx.agentSettings.findUnique({ where: { tenantId } }),
    tx.tenant.findFirst({
      select: { name: true, plan: true, status: true, settings: { select: { timezone: true } } },
    }),
    loadMessagingSettings(tx, tenantId),
  ])

  /**
   * **O que vale é o efetivo, e não o gravado.** Quem desce do Pro mantém a linha como
   * estava — voltar ao plano religa o agente com a mesma persona, sem reconfigurar nada —,
   * mas enquanto isso o agente responde como desligado e fala com a voz padrão. É aqui, e
   * não no runner, para que a tela, o prompt e o caminho de entrada leiam a mesma coisa.
   */
  const plan = PlanSchema.catch('STARTER').parse(tenant?.plan)
  const agent = planIncludes(plan, 'AI_AGENT')
  const persona = planIncludes(plan, 'AI_PERSONA')

  /**
   * O estado da conta desliga o agente pelo mesmo mecanismo do plano, e pelo mesmo
   * motivo: a linha fica como está, e voltar a pagar religa sem ninguém reconfigurar.
   *
   * É o único caminho do produto em que uma resposta chega ao cliente final **sem passar
   * pela fila** — o turno do modelo sai pelo `enqueueMessage`, mas quem decide se há turno
   * é esta configuração. Sem ela aqui, o bloqueio do despacho calaria o lembrete e
   * deixaria o robô de um petshop suspenso marcando horário que ninguém vai atender.
   */
  const operates = tenantOperates(tenant?.status)

  return {
    enabled: agent && operates && (row?.enabled ?? DEFAULTS.enabled),
    opensAt: row?.opensAt ?? DEFAULTS.opensAt,
    closesAt: row?.closesAt ?? DEFAULTS.closesAt,
    monthlyCapCents: row?.monthlyCapCents ?? DEFAULTS.monthlyCapCents,
    timezone: tenant?.settings?.timezone ?? DEFAULT_TIMEZONE,
    tenantName: tenant?.name ?? '',
    personaName: persona ? (row?.personaName ?? DEFAULTS.personaName) : DEFAULTS.personaName,
    tone: persona ? (row?.tone ?? DEFAULTS.tone) : DEFAULTS.tone,
    messagingEnabled: messaging.enabled,
  }
}

/**
 * A configuração com cache, para o caminho quente.
 *
 * Lida uma vez por mensagem recebida. Cinco minutos de TTL e invalidação no `PATCH`: o
 * pior caso é o agente continuar respondendo cinco minutos depois de alguém desligá-lo,
 * e quem desliga pela tela derruba a chave na hora.
 */
export async function loadSettings(tenantId: string): Promise<ResolvedAgentSettings> {
  const cached = await cacheGet<ResolvedAgentSettings>(CACHE_KEYS.agentSettings(tenantId))
  if (cached) return cached

  const resolved = await withTenant(tenantId, (tx) => readSettings(tx, tenantId))
  await cacheSet(CACHE_KEYS.agentSettings(tenantId), resolved, CACHE_TTL_SECONDS.agentSettings)
  return resolved
}

export async function getSettings(tenantId: string): Promise<AgentSettings> {
  const [resolved, spentCents] = await Promise.all([
    withTenant(tenantId, (tx) => readSettings(tx, tenantId)),
    monthlySpendCents(tenantId),
  ])

  return {
    enabled: resolved.enabled,
    opensAt: resolved.opensAt,
    closesAt: resolved.closesAt,
    monthlyCapCents: resolved.monthlyCapCents,
    personaName: resolved.personaName,
    tone: resolved.tone,
    spentCents,
    /**
     * **Sem motor de mensagens, ligar o agente não faria nada.**
     *
     * Ele leria a mensagem, chamaria o modelo, gastaria dinheiro e a resposta seria
     * recusada no enfileiramento com `ERR_CRM_013`. A tela precisa dizer isso antes,
     * e não depois da primeira conversa perdida.
     */
    canEnable: resolved.messagingEnabled,
  }
}

export async function updateSettings(
  actor: ActorContext,
  input: UpdateAgentSettingsInput,
): Promise<AgentSettings> {
  // A rota inteira já exige o agente (`plan-gates.ts`); a persona e o tom são o degrau
  // seguinte, e moram no mesmo PATCH.
  if (input.personaName !== undefined || input.tone !== undefined) {
    await assertFeature(actor.tenantId, 'AI_PERSONA')
  }

  await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await readSettings(tx, actor.tenantId)

      await tx.agentSettings.upsert({
        where: { tenantId: actor.tenantId },
        // `create` recebe os defaults **explicitamente somados ao pedido**: um upsert que
        // criasse a linha só com os campos do PATCH deixaria os demais no default do
        // banco, que por acaso é o mesmo — mas o "por acaso" é o que quebra quando um
        // default mudar.
        create: {
          tenantId: actor.tenantId,
          enabled: input.enabled ?? before.enabled,
          opensAt: input.opensAt ?? before.opensAt,
          closesAt: input.closesAt ?? before.closesAt,
          monthlyCapCents: input.monthlyCapCents ?? before.monthlyCapCents,
          personaName: input.personaName === undefined ? before.personaName : input.personaName,
          tone: input.tone ?? before.tone,
        },
        update: {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.opensAt === undefined ? {} : { opensAt: input.opensAt }),
          ...(input.closesAt === undefined ? {} : { closesAt: input.closesAt }),
          ...(input.monthlyCapCents === undefined
            ? {}
            : { monthlyCapCents: input.monthlyCapCents }),
          /**
           * `null` apaga, ausente não mexe — e é por isso que o teste é contra
           * `undefined` e não uma queda para o valor anterior. O `??` que serve para os
           * outros campos tornaria o nome impossível de remover.
           */
          ...(input.personaName === undefined ? {} : { personaName: input.personaName }),
          ...(input.tone === undefined ? {} : { tone: input.tone }),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'agent.settings_changed',
        entity: 'agent_settings',
        entityId: actor.tenantId,
        before: {
          enabled: before.enabled,
          opensAt: before.opensAt,
          closesAt: before.closesAt,
          monthlyCapCents: before.monthlyCapCents,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )

  await cacheDelete(CACHE_KEYS.agentSettings(actor.tenantId))
  return getSettings(actor.tenantId)
}

/**
 * O gasto do mês corrente, em centavos (AC-02 de MOD-AI-08).
 *
 * Somado dos **turnos**, e não das conversas: uma conversa que atravessa a virada do mês
 * pertenceria inteira a um mês só, e o teto do outro herdaria o gasto dela.
 *
 * O mês é o do calendário no fuso do estabelecimento. Em UTC, o teto viraria no fim da
 * tarde do dia 31 para quem está em São Paulo — e a fatura do petshop é do mês dele.
 */
export async function monthlySpendCents(tenantId: string, now = new Date()): Promise<number> {
  const { timezone } = await loadSettings(tenantId)
  const { from, key } = monthRange(now, timezone)

  const cached = await cacheGet<{ cents: number }>(CACHE_KEYS.agentSpend(tenantId, key))
  if (cached) return cached.cents

  const total = await withTenant(tenantId, (tx) =>
    tx.agentTurn.aggregate({
      where: { createdAt: { gte: from } },
      _sum: { costMillicents: true },
    }),
  )

  const cents = Math.round((total._sum.costMillicents ?? 0) / 1000)
  await cacheSet(CACHE_KEYS.agentSpend(tenantId, key), { cents }, CACHE_TTL_SECONDS.agentSpend)
  return cents
}

/** O primeiro instante do mês corrente no fuso do tenant, e a chave `AAAA-MM`. */
function monthRange(now: Date, timezone: string): { from: Date; key: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)

  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'

  // O primeiro dia do mês local, às 00:00 daquele fuso, expresso em UTC. `zonedDayRange`
  // faria o mesmo para um dia; aqui o recorte é o mês.
  const { from } = zonedMonthStart(`${year}-${month}-01`, timezone)
  return { from, key: `${year}-${month}` }
}

function zonedMonthStart(isoDate: string, timezone: string): { from: Date } {
  // O deslocamento do fuso naquele instante, descoberto comparando a leitura local com
  // a UTC. É o mesmo cálculo de `zonedDayRange` em `@petshop/shared-types`.
  const provisional = new Date(`${isoDate}T00:00:00Z`)
  const local = new Date(provisional.toLocaleString('en-US', { timeZone: timezone }))
  const utc = new Date(provisional.toLocaleString('en-US', { timeZone: 'UTC' }))
  const offsetMs = local.getTime() - utc.getTime()
  return { from: new Date(provisional.getTime() - offsetMs) }
}

/**
 * O agente está de plantão agora? (AC-03 de MOD-AI-07)
 *
 * Comparação de `HH:MM` como string, que funciona porque o formato é fixo e com zero à
 * esquerda — e porque o CHECK do banco garante `opens_at < closes_at`, o que exclui a
 * janela que atravessa a meia-noite.
 */
export function withinWindow(settings: ResolvedAgentSettings, now = new Date()): boolean {
  const local = new Intl.DateTimeFormat('pt-BR', {
    timeZone: settings.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  return local >= settings.opensAt && local < settings.closesAt
}
