import type { TenantTransaction } from '@petshop/db'
import { formatBRL } from '@petshop/shared-types'

/**
 * As variáveis que nascem do tutor e dos pets dele — as da fatia 3.
 *
 * O que separa este arquivo de `appointment-vars.ts` é a âncora: lá a mensagem é sobre
 * um horário e tudo sai do agendamento; aqui a mensagem é sobre a **pessoa** (o
 * aniversário dela, o sumiço dela, a dívida dela) e o que existe é a ficha.
 *
 * `formatList` mora aqui e é importada de lá: um tutor com três pets precisa ler
 * "Thor, Mel e Bidu" nas duas superfícies, e duas implementações da mesma frase acabam
 * divergindo na vírgula.
 */

/** "Thor", "Thor e Mel", "Thor, Mel e Bidu" — como se escreve, não como se itera. */
export function formatList(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`
}

/**
 * Os pets vivos do tutor, na frase pronta.
 *
 * **Vivos.** Um convite de volta que nomeia o cachorro morto é a pior mensagem que este
 * módulo é capaz de produzir, e o filtro precisa estar aqui — no lugar por onde toda
 * mensagem sobre a pessoa passa — e não em cada chamador.
 */
export async function petListOf(tx: TenantTransaction, tutorId: string): Promise<string> {
  const lists = await petListsOf(tx, [tutorId])
  return lists.get(tutorId) ?? ''
}

/**
 * O mesmo, para muita gente de uma vez.
 *
 * A campanha precisa da frase de cada destinatário, e pedi-la um a um seria uma
 * transação por tutor **antes** de cada salto HTTP — mil transações numa campanha de
 * mil, todas para ler uma lista de nomes. Uma consulta só, e o agrupamento em memória.
 */
export async function petListsOf(
  tx: TenantTransaction,
  tutorIds: string[],
): Promise<Map<string, string>> {
  if (tutorIds.length === 0) return new Map()

  const links = await tx.petTutor.findMany({
    where: {
      tutorId: { in: tutorIds },
      unlinkedAt: null,
      pet: { status: 'ACTIVE', deletedAt: null },
    },
    select: { tutorId: true, pet: { select: { name: true } } },
    orderBy: { linkedAt: 'asc' },
  })

  const names = new Map<string, string[]>()
  for (const link of links) {
    const list = names.get(link.tutorId) ?? []
    if (!list.includes(link.pet.name)) list.push(link.pet.name)
    names.set(link.tutorId, list)
  }

  return new Map([...names].map(([tutorId, list]) => [tutorId, formatList(list)]))
}

/**
 * As da régua de cobrança.
 *
 * `valor_devido` já sai **formatado em reais**: o template é escrito por quem atende no
 * balcão, e um valor em centavos escapando para o corpo da mensagem — "você deve 34500"
 * — é o erro mais caro que este catálogo pode cometer.
 *
 * O saldo é negativo quando há dívida (RN-02 do MOD-LEDGER), e é por isso que o valor
 * exibido é o **oposto** dele. Trocar o sinal aqui já custou um bug em duas telas do
 * Portal; a conta fica num lugar só.
 */
export function dunningVariables(options: {
  balanceCents: number
  daysLate: number
}): Record<string, string> {
  return {
    'financeiro.valor_devido': formatBRL(Math.abs(options.balanceCents)),
    'financeiro.dias_atraso': String(options.daysLate),
  }
}
