import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-PRONT, ligados ao catálogo do módulo.
 *
 * Valem para os três grupos de rota que vieram com ele — o prontuário de segurança, o
 * atendimento e o receituário —, porque os três respondem pelo mesmo catálogo de erro
 * (§5 do PRD prontuario_04) e pela mesma matriz do §9.
 *
 * A matriz é mais fina do que parece: `record:read_alerts` é de **todo mundo** que
 * encosta no animal, inclusive o motorista, porque quem abre a caixa de transporte
 * precisa saber que o pet morde. Desativar uma alergia já é `record:write`.
 */

export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})

export type { TenantScopedAuth } from '@petshop/service-kit'
