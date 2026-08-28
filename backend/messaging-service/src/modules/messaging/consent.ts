import { withTenant, type TenantTransaction } from '@petshop/db'
import type { MessageCategory, MessageChannel } from '@petshop/shared-types'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet } from '../../lib/redis.js'

/**
 * O consentimento do tutor (MOD-CRM-04, RN-01 e RN-02).
 *
 * **Este serviço lê e nunca grava.** A trilha jurídica é `tutor_consents`, do
 * MOD-TUTOR: append-only por trigger, com versão do termo, origem, IP e user agent.
 * Uma segunda trilha aqui criaria duas verdades sobre a mesma pergunta — e a que
 * valeria num processo seria a de lá.
 *
 * (O RN-02 diz "consulta o tutor-service"; a leitura é direta na tabela, como o
 * taxidog-service já lê `tutor_addresses` e `professionals`. O que importa da regra —
 * o CRM não escreve consentimento — vale integralmente.)
 *
 * A regra em uma frase: **`TRANSACTIONAL` e `OPERATIONAL` fluem por execução de
 * contrato; `MARKETING` exige consentimento vigente para aquele canal.** Ausência de
 * registro **não** é consentimento (LGPD art. 8º) — é o AC-03.
 */

export interface ConsentSnapshot {
  /** Canal → aceita marketing? */
  marketing: Record<MessageChannel, boolean>
}

/**
 * O estado atual de cada canal: a **última** transição vale, porque a tabela é
 * append-only e guarda a história inteira.
 */
export async function loadConsents(
  tx: TenantTransaction,
  tutorId: string,
): Promise<ConsentSnapshot> {
  const rows = await tx.tutorConsent.findMany({
    where: { tutorId, channel: { in: ['WHATSAPP', 'EMAIL'] } },
    orderBy: { createdAt: 'desc' },
    select: { channel: true, granted: true, purpose: true, createdAt: true },
  })

  const marketing: Record<MessageChannel, boolean> = { WHATSAPP: false, EMAIL: false }
  const seen = new Set<string>()

  for (const row of rows) {
    if (seen.has(row.channel)) continue
    seen.add(row.channel)
    const channel = row.channel as MessageChannel
    // `BOTH` e `MARKETING` liberam campanha; `TRANSACTIONAL` sozinho, não — é
    // exatamente a distinção que a decisão 14 pediu.
    marketing[channel] = row.granted && (row.purpose === 'MARKETING' || row.purpose === 'BOTH')
  }

  return { marketing }
}

export async function getConsents(tenantId: string, tutorId: string): Promise<ConsentSnapshot> {
  const key = CACHE_KEYS.consent(tenantId, tutorId)
  const cached = await cacheGet<ConsentSnapshot>(key)
  if (cached) return cached

  const snapshot = await withTenant(tenantId, (tx) => loadConsents(tx, tutorId))
  await cacheSet(key, snapshot, CACHE_TTL_SECONDS.consent)
  return snapshot
}

/** A pergunta que o motor faz antes de escolher o canal. */
export function allows(
  consents: ConsentSnapshot,
  channel: MessageChannel,
  category: MessageCategory,
): boolean {
  if (category !== 'MARKETING') return true
  return consents.marketing[channel]
}
