import { readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guarda do botão que espera.
 *
 * `<button className="btn …">` desenha a peça certa e não sabe esperar: quem clica em
 * Salvar fica olhando para um botão que não mudou até a tela trocar. O `<Button>` de
 * `components/ui.tsx` é a mesma peça com o anel, o rótulo de espera e a distinção entre
 * "já clicou" e "não pode clicar" — e o `<ButtonLink>` de `components/links.tsx` é o
 * irmão que espera a próxima tela em vez do backend.
 *
 * A varredura que trocou os 135 botões nativos de `src/app` por essas duas peças custou
 * uma tarde. O que a mantém é este teste: um botão nativo novo não quebra nada visível —
 * ele só volta a ser um botão que não responde ao clique, que é o defeito de onde tudo
 * isto partiu.
 *
 * A regra vale para `src/app`, que é onde moram as telas. `components/` é a exceção
 * óbvia: é lá que as duas peças imprimem a classe.
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../app')

/**
 * A tag de abertura inteira, com os atributos que quebram em várias linhas.
 *
 * `<button>` e `<Link>`, e não `<a>`: o `<a className="btn">` é a saída deliberada para
 * o arquivo que o navegador busca sozinho — o PDF do extrato, a exportação da LGPD, o
 * mapa que abre noutra aba. Nenhum deles tem espera para mostrar, e é a mesma recusa
 * que o `deveSinalizar` de `navegacao.ts` faz com `download` e destino externo.
 */
const ABERTURA = /<(button|Link)\b(?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*>/g

/** O valor do `className`, seja aspa, chave ou crase — a classe entra pelos três. */
const CLASSE = /className=(?:"[^"]*"|`[^`]*`|\{(?:[^{}]|\{[^{}]*\})*\})/
const TOKEN_BTN = /\bbtn\b/

function telas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) return telas(caminho)
    return entrada.name.endsWith('.tsx') ? [caminho] : []
  })
}

function nativosComClasseDeBotao(): string[] {
  const achados: string[] = []

  for (const caminho of telas(appDir)) {
    const fonte = readFileSync(caminho, 'utf8')
    for (const tag of fonte.match(ABERTURA) ?? []) {
      const classe = tag.match(CLASSE)?.[0]
      if (!classe || !TOKEN_BTN.test(classe)) continue
      const linha = fonte.slice(0, fonte.indexOf(tag)).split('\n').length
      achados.push(`${relative(appDir, caminho)}:${linha}`)
    }
  }

  return achados.sort()
}

describe('botões das telas', () => {
  it('nenhuma tela desenha um `<button>` ou `<Link>` com a classe `.btn`', () => {
    expect(nativosComClasseDeBotao()).toEqual([])
  })

  it('encontra as telas — a varredura em si não pode ter parado de funcionar', () => {
    expect(telas(appDir).length).toBeGreaterThanOrEqual(100)
  })
})
