/**
 * Title Case em português, a regra dos títulos do sistema.
 *
 * Três decisões que a função guarda:
 *
 * - **só a primeira letra de cada palavra muda.** O resto fica como está, para "PIX" não
 *   virar "Pix", "WhatsApp" não virar "Whatsapp" e o nome que o petshop deu a um produto
 *   não perder a grafia. É por isso que ela também é segura sobre dado digitado;
 * - **conectivos ficam minúsculos no meio da frase** — artigos, preposições e "e"/"ou":
 *   "Pagamento de Tutor", "Contas a Receber". No começo de um trecho sobem, como qualquer
 *   palavra ("O Caixa Está Fechado");
 * - **unidades de medida ficam minúsculas** — "Ração 15 kg", e não "15 Kg".
 *
 * Um trecho recomeça depois de `·`, `—`, `–`, `:`, `?` e `!`: "Venda Avulsa · A Granel".
 * A palavra com hífen só sobe a primeira parte ("Bem-vindo", "E-mail").
 */

// prettier-ignore
const LOWERCASE_WORDS = new Set([
  'a', 'à', 'ao', 'aos', 'as', 'às', 'o', 'os', 'um', 'uma', 'uns', 'umas',
  'de', 'da', 'das', 'do', 'dos', 'em', 'na', 'nas', 'no', 'nos',
  'e', 'ou', 'com', 'sem', 'para', 'por', 'pelo', 'pela', 'pelos', 'pelas',
])

const UNITS = new Set(['kg', 'g', 'mg', 'l', 'ml', 'un', 'cm', 'm', 'mm', 'h', 'min'])

/** Sinais que abrem um trecho novo — sozinhos ou colados no fim da palavra anterior. */
const SEGMENT_BREAKS = /^[·—–]$|[:?!]$/

export function titleCase(text: string): string {
  let segmentStart = true
  return text
    .split(' ')
    .map((word) => {
      if (word === '') return word
      if (SEGMENT_BREAKS.test(word) && !/\p{L}/u.test(word)) {
        segmentStart = true
        return word
      }
      const lower = word.toLocaleLowerCase('pt-BR')
      const keep = UNITS.has(lower) || (!segmentStart && LOWERCASE_WORDS.has(lower))
      segmentStart = SEGMENT_BREAKS.test(word)
      if (keep) return lower
      // A primeira **letra**, e não o primeiro caractere: "(opcional)" vira "(Opcional)".
      const index = word.search(/\p{L}/u)
      if (index < 0) return word
      return (
        word.slice(0, index) + word.charAt(index).toLocaleUpperCase('pt-BR') + word.slice(index + 1)
      )
    })
    .join(' ')
}
