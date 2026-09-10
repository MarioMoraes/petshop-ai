/**
 * As janelas da trilha, e o tipo que elas definem.
 *
 * **Ficam fora de `filtros.tsx` porque quem lê a lista é o servidor.** Um módulo
 * `'use client'` não exporta valores para um Server Component: o bundler troca cada
 * export por uma referência de cliente, e `JANELAS.map` deixa de ser função em tempo
 * de execução — sem erro de tipo, porque o TypeScript enxerga o módulo original.
 *
 * `92d` é o teto da consulta de auditoria do MOD-SEC, e não uma escolha de tela.
 */
export const JANELAS = [
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '92d', label: '92 dias' },
] as const

export type Janela = (typeof JANELAS)[number]['value']
