import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  AUTOMATION_KEYS,
  AutomationConfigSchema,
  TAXI_AUTOMATION_KEYS,
  type AutomationKey,
  type MessageChannelPref,
  type UpdateAutomationInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { invalidAutomation, notFound } from './errors.js'
import { tenantOptions, type ActorContext } from './actor.js'

/**
 * O que o petshop ligou e com que parâmetros (§2 do PRD).
 *
 * Como os templates, a linha só existe quando o petshop mexe — sem linha, valem os
 * padrões deste arquivo. Isso dá aos tenants existentes as automações sem backfill, e
 * acrescentar uma automação nova é editar uma constante.
 */

export interface ResolvedAutomation {
  key: AutomationKey
  enabled: boolean
  channel: MessageChannelPref
  templateKey: string
  config: Record<string, unknown>
  isDefault: boolean
  label: string
  description: string
}

/**
 * Os padrões.
 *
 * Note quais nascem **desligadas**: `appointment_cancelled` e `service_done`. O motivo
 * é o mesmo nos dois — são mensagens que o petshop pode não querer mandar, e ligá-las
 * por padrão faria o cliente receber, no primeiro dia de uso, avisos que ninguém
 * decidiu enviar. Lembrete e confirmação nascem ligados porque são o que o módulo
 * existe para fazer.
 */
const DEFAULTS: Record<
  AutomationKey,
  Omit<ResolvedAutomation, 'key' | 'isDefault'>
> = {
  appointment_confirmed: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'appointment_confirmed',
    config: {},
    label: 'Confirmação de agendamento',
    description: 'Sai assim que o horário é marcado, com data, serviço, pet e profissional.',
  },
  appointment_reminder: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'appointment_reminder',
    config: { leadHours: 24 },
    label: 'Lembrete de agendamento',
    description: 'Lembra o tutor do horário com a antecedência configurada.',
  },
  appointment_cancelled: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'appointment_cancelled',
    config: {},
    label: 'Aviso de cancelamento',
    description: 'Avisa o tutor quando o horário é cancelado pelo estabelecimento.',
  },
  service_done: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'service_done',
    config: {},
    label: 'Pet pronto',
    description: 'Avisa que o pet terminou o atendimento e pode ser buscado.',
  },

  // As do Taxi Dog nascem **ligadas**, ao contrário de "pet pronto".
  //
  // A diferença não é de gosto: "seu pet está pronto" é uma cortesia que o petshop pode
  // preferir dar por telefone, mas "o motorista está a caminho" é informação que o tutor
  // precisa ter para estar em casa quando a campainha tocar. Uma corrida anunciada
  // depois da chegada não anunciou nada — e o custo de não avisar recai sobre a coleta
  // frustrada, que é justamente o que o módulo tenta evitar.
  taxi_en_route: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'taxi_en_route',
    config: {},
    label: 'Taxi Dog a caminho',
    description: 'Avisa o tutor quando o motorista sai para a coleta, com a janela prometida.',
  },
  taxi_arrived: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'taxi_arrived',
    config: {},
    label: 'Taxi Dog chegou',
    description: 'Avisa que o motorista chegou no endereço e está esperando.',
  },
  taxi_delivered: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'taxi_delivered',
    config: {},
    label: 'Taxi Dog entregou',
    description: 'Confirma ao tutor que o pet chegou em casa.',
  },
  taxi_failed: {
    enabled: true,
    channel: 'AUTO',
    templateKey: 'taxi_failed',
    config: {},
    label: 'Coleta frustrada',
    description: 'Avisa o tutor quando não foi possível buscar o pet, e por quê.',
  },

  // As quatro da fatia 3 nascem **desligadas**, sem exceção.
  //
  // As três primeiras são MARKETING, e mandar promoção sem alguém ter decidido mandar é
  // o erro que custa o consentimento de toda a base. A quarta é cobrança — e cobrar por
  // mensagem automática é decisão de quem responde pelo caixa, não um padrão que o
  // cliente descobre pelo celular do inadimplente.
  birthday_pet: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'birthday_pet',
    config: { sendHour: 9, includeEstimated: false },
    label: 'Aniversário do pet',
    description: 'Felicita o tutor no aniversário do pet. Nunca sai para pet falecido.',
  },
  birthday_tutor: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'birthday_tutor',
    config: { sendHour: 9 },
    label: 'Aniversário do tutor',
    description: 'Felicita o tutor no aniversário dele.',
  },
  inactive_campaign: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'winback',
    config: { sendHour: 10, inactiveDays: 90, cooldownDays: 60 },
    label: 'Convite de volta',
    description:
      'Convida de volta quem não aparece há um tempo. Não convida quem tem valor em aberto.',
  },
  dunning: {
    enabled: false,
    channel: 'AUTO',
    templateKey: 'dunning_soft',
    config: {
      sendHour: 9,
      steps: [
        { days: 3, templateKey: 'dunning_soft' },
        { days: 10, templateKey: 'dunning_firm' },
        { days: 30, templateKey: 'dunning_final' },
      ],
      minDebtCents: 2000,
    },
    label: 'Régua de cobrança',
    description:
      'Avisa quem tem valor em aberto, em degraus. Pagar em qualquer ponto interrompe a régua.',
  },
}

export async function resolveAutomation(
  tx: TenantTransaction,
  key: AutomationKey,
): Promise<ResolvedAutomation> {
  const base = DEFAULTS[key]
  const override = await tx.automation.findFirst({ where: { key } })

  if (!override) return { key, isDefault: true, ...base }

  return {
    key,
    isDefault: false,
    enabled: override.enabled,
    channel: override.channel as MessageChannelPref,
    templateKey: override.templateKey ?? base.templateKey,
    config: { ...base.config, ...((override.config as Record<string, unknown>) ?? {}) },
    label: base.label,
    description: base.description,
  }
}

export async function listAutomations(tenantId: string): Promise<ResolvedAutomation[]> {
  return withTenant(tenantId, async (tx) => {
    // AC-04 de MOD-CRM-09: com o Taxi Dog desligado, as automações dele não aparecem.
    // Quatro interruptores que não fazem nada, no meio dos que fazem, ensinam o admin a
    // não confiar na tela.
    const taxi = await tx.taxiSettings.findFirst({ select: { enabled: true } })
    const taxiOn = taxi?.enabled ?? false
    const hidden = new Set<string>(taxiOn ? [] : TAXI_AUTOMATION_KEYS)

    const resolved: ResolvedAutomation[] = []
    for (const key of AUTOMATION_KEYS) {
      if (hidden.has(key)) continue
      resolved.push(await resolveAutomation(tx, key))
    }
    return resolved
  })
}

/**
 * Valida a `config` **pela chave** — não como JSON solto.
 *
 * Uma automação com `leadHours` num campo que ninguém lê é uma automação que o petshop
 * acha que configurou, e é o tipo de erro que só aparece quando o lembrete não chega.
 */
function validateConfig(key: AutomationKey, config: Record<string, unknown>): void {
  const parsed = AutomationConfigSchema.safeParse({ key, ...config })
  if (!parsed.success) {
    throw invalidAutomation(
      'Configuração inválida para esta automação',
      parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'config',
        message: issue.message,
      })),
    )
  }
}

export async function updateAutomation(
  actor: ActorContext,
  key: string,
  input: UpdateAutomationInput,
): Promise<ResolvedAutomation> {
  if (!(AUTOMATION_KEYS as readonly string[]).includes(key)) {
    throw notFound(`Não existe uma automação chamada "${key}"`)
  }
  const automationKey = key as AutomationKey

  return withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await resolveAutomation(tx, automationKey)
      const config = { ...before.config, ...(input.config ?? {}) }
      validateConfig(automationKey, config)

      await tx.automation.upsert({
        where: { tenantId_key: { tenantId: actor.tenantId, key: automationKey } },
        update: {
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
          config,
          updatedBy: actor.actorUserId ?? null,
        },
        create: {
          tenantId: actor.tenantId,
          key: automationKey,
          enabled: input.enabled ?? before.enabled,
          channel: input.channel ?? before.channel,
          templateKey: input.templateKey ?? before.templateKey,
          config,
          updatedBy: actor.actorUserId ?? null,
        },
      })

      const after = await resolveAutomation(tx, automationKey)

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'automation.updated',
        entity: 'automations',
        entityId: automationKey,
        before: { enabled: before.enabled, channel: before.channel, config: before.config },
        after: { enabled: after.enabled, channel: after.channel, config: after.config },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return after
    },
    tenantOptions(actor),
  )
}
