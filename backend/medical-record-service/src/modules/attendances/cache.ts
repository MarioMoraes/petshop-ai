import { cacheDelete } from '../../lib/redis.js'

/**
 * Cache do resumo clínico (PRD prontuario_04 §10).
 *
 * Separado de `lib/redis.ts` porque a chave é do atendimento, não do alerta: o
 * resumo muda quando o pet é atendido, e os alertas mudam quando alguém registra
 * uma alergia. Misturar as duas invalidações faria toda conclusão de banho apagar
 * o cache quente que a agenda lê a cada abertura de ficha.
 */

export const SUMMARY_KEY = (tenantId: string, petId: string) =>
  `pront:summary:${tenantId}:${petId}`

/** §10: 300s. O resumo tolera atraso; o alerta de segurança, não. */
export const SUMMARY_TTL_SECONDS = 300

export async function invalidateSummary(tenantId: string, petId: string): Promise<void> {
  await cacheDelete(SUMMARY_KEY(tenantId, petId))
}
