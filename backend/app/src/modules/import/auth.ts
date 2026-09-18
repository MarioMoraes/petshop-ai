import { createModuleAuth } from '../../shared/auth-context.js'
import { forbidden, unauthorized } from './errors.js'

/**
 * Os guardas do MOD-IMPORT, ligados ao catálogo do módulo.
 *
 * **Todas** as rotas pedem o mesmo `import:run` — inclusive a análise, que não grava
 * nada, e o histórico. A análise devolve a planilha do cliente remontada linha a linha
 * (nome, CPF e celular da carteira inteira) e o histórico diz quem carregou o quê: é o
 * mesmo público nos três, e um `import:read` separado só criaria um papel com meia
 * migração na mão.
 */

export const { requireTenantContext, hasPermission, requirePermission } = createModuleAuth({
  forbidden,
  unauthorized,
})
