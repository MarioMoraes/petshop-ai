/**
 * O tamanho de todo cartão do Início, e do esqueleto que ocupa o lugar dele: 280 por
 * 224px a partir de `sm`. É a proporção do cartão de referência que o usuário trouxe em
 * 2026-10-07 (5 por 4), em escala maior: no tamanho do print, 180 por 144, e depois em
 * 240 por 192, ficou pequeno na tela do computador.
 *
 * Tamanho **fixo**, e não proporção da coluna: numa coluna de um terço da tela o cartão
 * cresceria até 330px. A largura é fixa só a partir de `sm` — no celular a coluna é meia
 * tela, e ali a altura mínima cai para 144px, para o cartão não ficar mais alto que
 * largo. A altura é **mínima**: um valor longo ("R$ 12.345,67 perdidos") quebra em duas
 * linhas, e o cartão cresce em vez de cortar o número — a grade iguala a linha.
 *
 * Mora fora de `page.tsx` porque página do Next só exporta o que o framework reconhece, e
 * o `loading.tsx` precisa do mesmo tamanho para não trocá-lo quando os dados chegam.
 */
export const STAT_SHAPE = 'min-h-36 sm:min-h-56'

/**
 * A grade das faixas: duas colunas no celular e, a partir de `sm`, quantas colunas de
 * 280px couberem.
 *
 * As colunas têm a largura do cartão, e não uma fração da tela: é o que mantém o cartão
 * no tamanho de referência em qualquer monitor. As faixas ficam encostadas à esquerda,
 * cada uma com o número de cartões que tem.
 */
export const STAT_GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,17.5rem)]'
