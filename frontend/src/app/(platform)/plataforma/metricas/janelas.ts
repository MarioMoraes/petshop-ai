/**
 * As janelas da série, e o tipo que elas definem.
 *
 * **Ficam fora de `consulta.tsx` porque quem lê a lista é o servidor.** Um módulo
 * `'use client'` não exporta valores para um Server Component: o bundler troca cada
 * export por uma referência de cliente, e `JANELAS.map` deixa de ser função em tempo
 * de execução — sem erro de tipo, porque o TypeScript enxerga o módulo original.
 * A rota valida `?janela=` e converte a janela em recuo, então a lista precisa nascer
 * num módulo neutro, que os dois lados importam.
 */
export const JANELAS = [
  { value: '24h', label: '24 horas' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '13m', label: '13 meses' },
] as const

export type Janela = (typeof JANELAS)[number]['value']
