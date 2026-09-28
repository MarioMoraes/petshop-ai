import { Children, isValidElement, type ReactNode } from 'react'
import { titleCase } from '@petshop/shared-types'

/**
 * `titleCase` sobre o rótulo de uma peça, quando o rótulo é texto.
 *
 * O filho de um botão chega de três jeitos: string, lista de pedaços (`Excluir {nome}`
 * vira `['Excluir ', nome]`) ou JSX. Os pedaços de texto são **juntados antes** de
 * converter: convertidos um a um, cada pedaço recomeçaria a frase e o conectivo do
 * meio ("Salvar {x} do pet") subiria para maiúscula. JSX passa intacto — quem o
 * escreveu decide a caixa dele.
 */
export function titleCaseNode(node: ReactNode): ReactNode {
  if (typeof node === 'string') return titleCase(node)
  const parts = Children.toArray(node)
  if (parts.length > 0 && parts.every((p) => typeof p === 'string' || typeof p === 'number')) {
    return titleCase(parts.join(''))
  }
  return Children.map(node, (child) =>
    typeof child === 'string' && !isValidElement(child) ? titleCase(child) : child,
  )
}
