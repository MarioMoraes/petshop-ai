import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guarda do esqueleto de carregamento.
 *
 * Toda seção do Admin monta a `AppShell` no próprio `layout.tsx`, e é isso que dá ao
 * `loading.tsx` irmão o que ele precisa: o limite de suspensão fica **abaixo** da
 * moldura, então o esqueleto nasce com menu e faixa já na tela, no lugar do miolo.
 *
 * Seção nova sem `loading.tsx` não quebra nada visível — ela só volta a ser uma tela que
 * não responde ao clique enquanto o servidor monta a página, que é o defeito de onde
 * tudo isto partiu. Este teste é o que faz esse esquecimento aparecer.
 *
 * O Portal tem um `loading.tsx` só, na raiz, porque a moldura de lá é montada por cada
 * página e não há menu a preservar. O console da plataforma não tem nenhum, pela razão
 * inversa: a moldura dele também é por página, mas **tem** lateral — e um esqueleto que
 * apagasse a lateral a cada clique seria pior que a barra de progresso sozinha.
 */

const adminDir = resolve(dirname(fileURLToPath(import.meta.url)), '../app/(admin)')

/** Seções são as pastas com layout próprio: é o layout que monta a moldura. */
function secoesComMoldura(): string[] {
  return readdirSync(adminDir, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .filter((entrada) => readdirSync(join(adminDir, entrada.name)).includes('layout.tsx'))
    .map((entrada) => entrada.name)
    .sort()
}

describe('limites de carregamento do Admin', () => {
  it('toda seção com moldura própria tem um `loading.tsx`', () => {
    const semEsqueleto = secoesComMoldura().filter(
      (secao) => !readdirSync(join(adminDir, secao)).includes('loading.tsx'),
    )

    expect(semEsqueleto).toEqual([])
  })

  it('encontra as seções — a varredura em si não pode ter parado de funcionar', () => {
    expect(secoesComMoldura().length).toBeGreaterThanOrEqual(11)
  })
})
