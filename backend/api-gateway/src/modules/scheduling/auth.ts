import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-AGENDA, ligados ao catálogo do módulo.
 *
 * Valem para as duas metades da fatia — os agendamentos e o catálogo de serviços,
 * profissionais e bloqueios —, porque as duas respondem pelo mesmo `ERR_AGENDA_003`
 * na negação (PRD agenda_operacao_06 §9).
 *
 * O recorte do §9 que mais importa é o do catálogo: `schedule:manage_catalog` é só do
 * administrador, e a recepção — que marca o dia inteiro com `schedule:write_all` — não
 * mexe em preço nem em jornada.
 */

export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})

export type { TenantScopedAuth } from '@petshop/service-kit'
