import { expirePendingInvitations } from '@petshop/db'
import { logger } from '../../lib/logger.js'

/**
 * MOD-IDENT-06 — varredura diária dos convites vencidos.
 *
 * O job **não** é o que faz o convite expirar: `effectiveStatus` já recusa um convite
 * fora do prazo no instante do uso, e depender de uma varredura para isso deixaria
 * uma janela de até 24h em que um link morto ainda abriria a porta. O que ele faz é
 * pôr o banco de acordo com a realidade, para que a lista da tela de equipe não
 * mostre como "pendente" um convite que ninguém mais consegue aceitar.
 *
 * É cross-tenant por natureza — roda pela role `app_maintenance`, como manda o §4.
 */
export async function runExpireInvitationsOnce(): Promise<void> {
  const expired = await expirePendingInvitations()
  if (expired > 0) logger.info({ expired }, 'convites vencidos marcados como EXPIRED')
}
