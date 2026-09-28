import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guarda do estado vazio com rosto.
 *
 * O `EmptyState` de `components/ui.tsx` exige `icon` e `tone` no tipo, e esta varredura
 * é a segunda guarda, sobre todas as raízes de `src/app`. O ícone é obrigatório: o
 * chip do domínio é o que separa "a área ainda está vazia" de "a página não terminou
 * de ser feita", e um estado vazio novo sem ele não quebra nada
 * visível — só volta a ser o cartão de texto de onde a varredura partiu.
 *
 * Qual ícone usar está no comentário da peça: o da área para o vazio de verdade, o
 * triângulo para o "não respondeu", o escudo para o "sem acesso".
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../app')

/** A tag de abertura inteira, com os atributos que quebram em várias linhas. */
const ABERTURA = /<EmptyState\b(?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\/?>/g

function telas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) return telas(caminho)
    return entrada.name.endsWith('.tsx') ? [caminho] : []
  })
}

function varrer(): { total: number; semIcone: string[]; semTom: string[] } {
  let total = 0
  const semIcone: string[] = []
  const semTom: string[] = []

  for (const caminho of telas(appDir)) {
    const fonte = readFileSync(caminho, 'utf8')
    for (const tag of fonte.match(ABERTURA) ?? []) {
      total += 1
      const linha = fonte.slice(0, fonte.indexOf(tag)).split('\n').length
      if (!/\bicon=/.test(tag)) semIcone.push(`${relative(appDir, caminho)}:${linha}`)
      else if (!/\btone=/.test(tag)) semTom.push(`${relative(appDir, caminho)}:${linha}`)
    }
  }

  return { total, semIcone: semIcone.sort(), semTom: semTom.sort() }
}

describe('estados vazios', () => {
  it('todo `<EmptyState>` das telas traz o ícone', () => {
    expect(varrer().semIcone).toEqual([])
  })

  it('todo ícone de `<EmptyState>` tem o tom do domínio — nenhum ícone sem cor', () => {
    expect(varrer().semTom).toEqual([])
  })

  it('encontra os estados vazios — a varredura em si não pode ter parado de funcionar', () => {
    expect(varrer().total).toBeGreaterThanOrEqual(40)
  })
})
