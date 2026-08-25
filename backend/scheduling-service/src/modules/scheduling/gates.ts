import type { TenantTransaction } from '@petshop/db'
import { AppError, formatBRL } from '@petshop/shared-types'
import { invalid } from '../../lib/errors.js'

/**
 * Os gates do MOD-AGENDA-10 — o que se checa **antes** de gravar.
 *
 * Os três seguem a mesma filosofia, que é a decisão de negócio 6: **alertar sempre,
 * bloquear por opt-in**. Nenhum deles impede o atendimento em definitivo; todos
 * exigem que alguém assuma a responsabilidade por escrito.
 *
 * Rodam em transação de leitura própria, **fora** da transação serializável da
 * criação. Manter a janela serializável curta reduz a chance de dois pedidos
 * legítimos se abortarem — e um gate que consulta três tabelas dentro dela seria
 * puro custo de contenção.
 */

// ─── RN-09 — alerta clínico crítico ──────────────────────────────────────────

export interface BlockingAlert {
  id: string
  label: string
  severity: string
  kind: 'ALLERGY'
}

/**
 * Alergia CRÍTICA que o serviço dispara.
 *
 * As tabelas são do medical-record-service, e lê-las daqui é o mesmo acoplamento
 * assumido que o pet-service já tem (`attachAlerts`). A alternativa seria uma chamada
 * HTTP no caminho de criação do agendamento — e o serviço do outro lado abriria a
 * própria transação, o que não ajudaria em consistência e custaria latência no
 * balcão.
 *
 * A **regra** de o que bloqueia continua sendo do prontuário: `blocksServices` é
 * preenchido lá, por quem entende de clínica. Aqui só se lê o resultado.
 */
export async function findBlockingAlerts(
  tx: TenantTransaction,
  petId: string,
  serviceIds: string[],
): Promise<BlockingAlert[]> {
  const conflicting = await tx.allergy.findMany({
    where: {
      petId,
      active: true,
      severity: 'CRITICAL',
      blocksServices: { hasSome: serviceIds },
    },
    select: { id: true, label: true, severity: true },
    orderBy: { createdAt: 'desc' },
  })

  return conflicting.map((row) => ({
    id: row.id,
    label: row.label,
    severity: row.severity,
    kind: 'ALLERGY' as const,
  }))
}

/**
 * AC-01: bloqueio **suave**. Informa, exige confirmação consciente e não impede o
 * atendimento — repetir o POST com `acknowledgedAlerts: true` conclui.
 *
 * O nome de quem reconheceu vai para `acknowledged_alerts_by`, e é essa linha que
 * responde "quem assumiu o risco" quando alguém perguntar meses depois.
 */
export function assertAlertsAcknowledged(alerts: BlockingAlert[], acknowledged: boolean): void {
  if (alerts.length === 0 || acknowledged) return

  const labels = alerts.map((alert) => alert.label).join(', ')
  throw new AppError(
    'ERR_AGENDA_009',
    `Este pet tem alerta clínico CRÍTICO para o serviço escolhido (${labels}). Confirme que a equipe está ciente para prosseguir.`,
    undefined,
    { alerts, requiresAcknowledgement: true },
  )
}

// ─── RN-11 — inadimplência ───────────────────────────────────────────────────

export interface CreditStatus {
  balanceCents: number
  /** Nulo **nunca** bloqueia — é o padrão do sistema (decisão de negócio 6). */
  creditLimitCents: number | null
}

/**
 * Porta para o MOD-LEDGER.
 *
 * O RN-11 depende de `billing_settings.credit_limit_cents`, tabela que o MOD-LEDGER
 * ainda não criou; e `tutors.balance_cents`, que existe mas é alimentado por um
 * consumidor de `lancamento.criado` sem publicador. A regra está escrita e testada
 * atrás desta porta — mesmo padrão da porta de `appointments` na fatia 1.
 *
 * O padrão lê o saldo real (a coluna existe) e devolve limite nulo, que é
 * literalmente o que o AC-03 descreve: sem limite configurado, o agendamento passa e
 * o débito aparece como alerta. Ou seja, o comportamento de hoje já é o correto — o
 * que falta é só o petshop poder configurar o limite.
 */
export interface BillingPort {
  creditStatus: (tx: TenantTransaction, tutorId: string) => Promise<CreditStatus>
}

const defaultBillingPort: BillingPort = {
  async creditStatus(tx, tutorId) {
    const tutor = await tx.tutor.findFirst({
      where: { id: tutorId },
      select: { balanceCents: true },
    })
    return { balanceCents: tutor?.balanceCents ?? 0, creditLimitCents: null }
  },
}

let billingPort: BillingPort = defaultBillingPort

export function billing(): BillingPort {
  return billingPort
}

export function setBillingPort(port: BillingPort): void {
  billingPort = port
}

export function resetBillingPort(): void {
  billingPort = defaultBillingPort
}

/**
 * AC-02: acima do limite, só um TENANT_ADMIN passa, com justificativa auditada.
 *
 * `canOverride` chega da permissão, não do papel: quem decide é a matriz do RBAC, e
 * repetir "é TENANT_ADMIN?" aqui criaria uma segunda fonte de verdade.
 */
export function assertCreditAllowed(
  status: CreditStatus,
  override: { reason: string } | undefined,
  canOverride: boolean,
): void {
  // AC-03: limite nulo nunca bloqueia. O saldo vira alerta na tela, não barreira.
  if (status.creditLimitCents === null) return

  // **Atenção ao sinal.** `balanceCents` é negativo quando o tutor deve (RN-02), e
  // `creditLimitCents` é positivo. Comparar os dois diretamente — como esta linha
  // fazia — nunca bloqueava nada: `-28000 <= 30000` é sempre verdade. O que se compara
  // é a **dívida** com o limite. O bug era inerte enquanto o limite era sempre nulo;
  // deixou de ser no dia em que `billing_settings` passou a existir.
  const debtCents = Math.max(0, -status.balanceCents)
  if (debtCents <= status.creditLimitCents) return

  if (override) {
    if (!canOverride) {
      throw new AppError(
        'ERR_AGENDA_008',
        'Somente um administrador pode liberar agendamento acima do limite de crédito',
        undefined,
        { balanceCents: status.balanceCents, creditLimitCents: status.creditLimitCents },
      )
    }
    return
  }

  throw new AppError(
    'ERR_AGENDA_008',
    `O tutor tem ${formatBRL(debtCents)} em aberto, acima do limite de ${formatBRL(status.creditLimitCents)}`,
    undefined,
    {
      balanceCents: status.balanceCents,
      creditLimitCents: status.creditLimitCents,
      requiresOverride: true,
    },
  )
}

// ─── RN-07 — antecedência mínima ─────────────────────────────────────────────

/**
 * A antecedência mínima vale **só para o Portal**.
 *
 * No balcão ela não existe, e isso não é descuido: o tutor está na frente do
 * atendente, com o pet na mão. Exigir duas horas de antecedência de quem já chegou
 * seria o sistema negando a realidade que está vendo (decisão de negócio 9).
 */
export function assertMinimumNotice(
  startsAt: Date,
  source: string,
  minNoticeHours: number,
  now: Date = new Date(),
): void {
  if (source !== 'PORTAL') return

  const earliest = new Date(now.getTime() + minNoticeHours * 60 * 60_000)
  if (startsAt.getTime() >= earliest.getTime()) return

  throw new AppError(
    'ERR_AGENDA_007',
    `Agendamentos pelo portal exigem ${minNoticeHours}h de antecedência`,
    undefined,
    { nextAvailable: earliest.toISOString(), minNoticeHours },
  )
}

/** Lê a política do tenant; o padrão de 2h é a decisão de negócio 9. */
export async function loadNoticeHours(tx: TenantTransaction, tenantId: string): Promise<number> {
  const settings = await tx.tenantSettings.findFirst({
    where: { tenantId },
    select: { minBookingNoticeHours: true },
  })
  return settings?.minBookingNoticeHours ?? 2
}

/** Reexportado para o serviço montar o 422 de dados inválidos sem importar errado. */
export { invalid }
