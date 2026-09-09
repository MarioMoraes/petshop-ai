import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas de autorização do MOD-PORTAL, ligados ao catálogo do módulo.
 *
 * **É o único módulo do processo que usa `requireTutorContext` e `requireOwnScope`.** Os
 * dois vêm do `@petshop/service-kit` como os demais, e são o gate real de quase toda rota
 * daqui: sem `tutorId` no contexto, a sessão do Clerk é válida mas não corresponde a ficha
 * nenhuma neste petshop — 401, e não 403, porque não é falta de permissão, é uma sessão
 * que não representa cliente algum.
 *
 * `requireOwnScope` é o que faz o RN-02 deixar de depender de disciplina: quem lê o
 * recorte **não compila** sem ter passado pelo gate.
 */

export const {
  requireTenantContext,
  requireTutorContext,
  requireOwnScope,
  hasPermission,
  requirePermission,
} = createModuleAuth({ forbidden, unauthorized })

export type { TenantScopedAuth, TutorScopedAuth } from '@petshop/service-kit'
