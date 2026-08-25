/**
 * Dinheiro na plataforma (PRD financeiro_tutor_05 §4).
 *
 * **Todo valor é inteiro em centavos**, nunca `Decimal` nem `Float`. A regra já valia
 * de fato — `service_pricing.price_cents` e `appointment_items.price_cents` nasceram
 * `BigInt` —, mas até aqui cada tela reinventava a formatação: havia quatro cópias
 * inline de `toLocaleString('pt-BR', { style: 'currency' })` no frontend, com
 * comportamentos sutilmente diferentes. Este módulo é a quinta que não vai existir.
 *
 * Fica em `shared-types` porque backend e frontend precisam concordar sobre o teto de
 * sanidade e sobre como um valor digitado no balcão vira centavos.
 */

/**
 * R$ 1.000.000,00 — teto de sanidade do AC-04 de MOD-LEDGER-02.
 *
 * Não existe para limitar o negócio (nenhum banho custa isso); existe para que um
 * dedo escorregando no teclado numérico vire 422 e não uma dívida de sete dígitos na
 * conta de alguém.
 */
export const MAX_MONEY_CENTS = 100_000_000

/** `1250` → `"R$ 12,50"`. */
export function formatBRL(cents: number | bigint): string {
  return (Number(cents) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

/**
 * `1250` → `"12,50"` — o mesmo número sem o símbolo, para dentro de `<input>`.
 *
 * Separado de `formatBRL` porque campo de formulário com "R$" embutido obriga o
 * usuário a apagar o prefixo antes de digitar.
 */
export function formatCentsInput(cents: number | bigint): string {
  return (Number(cents) / 100).toFixed(2).replace('.', ',')
}

/**
 * `"R$ 1.234,56"`, `"1234,56"`, `"1.234,56"` → `123456`.
 *
 * Aceita o que o balcão realmente digita: com ou sem símbolo, com ou sem separador de
 * milhar, vírgula **ou** ponto como decimal. Devolve `null` quando não sobra número —
 * a rota decide se isso é 422, porque só ela sabe se o campo era obrigatório.
 *
 * O arredondamento é *half-up* explícito (`Math.round` sobre o valor já em centavos):
 * `"12,345"` vira `1235`, não `1234`. Meio centavo a favor de quem paga é o erro que
 * não precisa ser explicado.
 */
export function parseBRLToCents(input: string): number | null {
  const cleaned = input.replace(/[^\d,.-]/g, '').trim()
  if (cleaned === '' || cleaned === '-') return null

  // O último separador é o decimal; os anteriores são milhar. Resolve "1.234,56" e
  // "1,234.56" sem precisar saber a localidade do teclado.
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  const decimalAt = Math.max(lastComma, lastDot)

  const normalized =
    decimalAt === -1
      ? cleaned.replace(/[.,]/g, '')
      : `${cleaned.slice(0, decimalAt).replace(/[.,]/g, '')}.${cleaned.slice(decimalAt + 1)}`

  const value = Number(normalized)
  if (!Number.isFinite(value)) return null

  return Math.round(value * 100)
}

/**
 * Percentual sobre um valor em centavos, arredondado *half-up*.
 *
 * Usado pela taxa de no-show e pelo desconto percentual. Existe como função para que a
 * conta seja a mesma nos dois lugares — `Math.round(x * p / 100)` escrito duas vezes
 * é a receita para divergirem no dia em que alguém "melhorar" uma delas.
 */
export function percentOfCents(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100)
}
