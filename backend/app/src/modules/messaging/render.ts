import { extractVariables, findTemplateDefinition } from '@petshop/shared-types'

/**
 * Substituição de `{{namespace.campo}}` (apêndice do PRD).
 *
 * Duas regras que parecem detalhe e não são:
 *
 * 1. **A validação é na gravação, não no envio.** Variável inventada renderizaria
 *    vazio no celular do cliente; o erro precisa doer na hora de escrever o texto
 *    (AC-03 de MOD-CRM-02).
 * 2. **A whitelist é por template.** `taxi.motivo_falha` só existe no aviso de coleta
 *    frustrada. Uma lista global deixaria o petshop escrever, no lembrete de banho,
 *    uma variável que naquele contexto nunca terá valor.
 */

const PLACEHOLDER = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g

export interface RenderResult {
  text: string
  /** Variáveis do texto que ninguém forneceu — renderizadas como vazio. */
  missing: string[]
}

export function render(template: string, variables: Record<string, string | number>): RenderResult {
  const missing: string[] = []
  const text = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name]
    if (value === undefined || value === null || value === '') {
      missing.push(name)
      return ''
    }
    return String(value)
  })
  // Uma linha que ficou só com espaços porque a variável sumiu polui o texto final;
  // colapsar três quebras ou mais em duas mantém os parágrafos e some com o buraco.
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), missing }
}

export class UnknownVariablesError extends Error {
  constructor(
    readonly unknown: string[],
    readonly allowed: readonly string[],
  ) {
    super(`Variáveis desconhecidas: ${unknown.join(', ')}`)
  }
}

/**
 * Confere o corpo escrito pelo petshop contra a whitelist do template.
 *
 * Templates fora do catálogo (os que a fatia 3 acrescentar) não são recusados aqui —
 * a checagem de existência é do chamador, e este módulo só sabe validar o que conhece.
 */
export function assertKnownVariables(templateKey: string, body: string, subject?: string): void {
  const definition = findTemplateDefinition(templateKey)
  if (!definition) return

  const allowed = new Set<string>(definition.variables)
  const used = [...extractVariables(body), ...(subject ? extractVariables(subject) : [])]
  const unknown = [...new Set(used.filter((name) => !allowed.has(name)))]

  if (unknown.length > 0) throw new UnknownVariablesError(unknown, definition.variables)
}
