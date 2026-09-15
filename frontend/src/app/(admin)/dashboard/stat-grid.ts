/**
 * A altura mínima de todo cartão de número do Início, e do esqueleto que ocupa o lugar dele.
 *
 * É a soma do molde com a dica em duas linhas: 24px de padding em cima e embaixo, o chip
 * de 36, 16 até a figura de 36, o rótulo de 24, 8 até a dica e as duas linhas dela. Sem
 * ela a grade estica cada linha até o cartão mais alto **daquela** linha, e duas faixas
 * seguidas saem com alturas diferentes — que é o desalinhamento que se vê ao rolar.
 *
 * Mora fora de `page.tsx` porque página do Next só exporta o que o framework reconhece, e
 * o `loading.tsx` precisa do mesmo número para não trocar de forma quando os dados chegam.
 */
export const STAT_MIN_HEIGHT = 'min-h-[13.5rem]'

/**
 * A grade das faixas: uma coluna no celular, duas no tablet, três a partir de `lg`.
 *
 * Toda faixa é escrita para fechar linhas de três, e no desktop isso basta. Em duas
 * colunas, três cartões viram dois e um sobrando — e é esse último que ocupa a linha
 * inteira, **só entre `sm` e `lg`**. No desktop nenhum cartão se alarga: o gráfico em
 * largura dupla foi recusado, e a regra não pode reintroduzi-lo pela porta dos fundos.
 */
export const STAT_GRID =
  'grid gap-5 sm:grid-cols-2 lg:grid-cols-3 sm:max-lg:[&>*:last-child:nth-child(odd)]:col-span-2'
