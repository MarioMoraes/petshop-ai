'use server'

import { headers } from 'next/headers'
import { SiteLeadInputSchema, type FieldError } from '@petshop/shared-types'
import { submitLead, type LeadResult } from '@/lib/site-api'

/**
 * O envio do formulário público.
 *
 * Passa por Server Action, e não por `fetch` do browser: o backend não é publicado
 * pela borda (o Caddy entrega só o Next), então o browser não teria como alcançá-lo —
 * e não precisa. O IP do visitante é lido aqui e repassado ao módulo do site, que é
 * quem aplica o teto de três envios por quinze minutos.
 */

export interface LeadFormState extends LeadResult {
  fieldErrors?: FieldError[]
}

/** Os campos que o visitante pode legitimamente deixar em branco. */
const OPCIONAIS = ['email', 'message', 'website'] as const

/**
 * Campo opcional em branco é **ausente**, não string vazia.
 *
 * O `FormData` do browser não distingue as duas coisas: ele devolve `''` para todo
 * campo que existe no formulário, tocado ou não. O schema distingue — `optional()`
 * cobre a chave ausente, e `''` cai direto na validação de formato. Sem esta
 * normalização, quem não preenchia o e-mail recebia "endereço inválido" no campo que
 * a própria etiqueta chama de opcional, e o envio inteiro era recusado.
 *
 * A conversão mora aqui, e não no schema, porque o problema é da **fronteira**: é o
 * `FormData` que inventa a string vazia. O endpoint público continua recusando um
 * `email: ''` mandado à mão, que é um cliente dizendo algo diferente de "não tenho".
 *
 * `name` e `phone` ficam de fora de propósito: em branco eles são erro de verdade, e
 * "informe pelo menos 2 caracteres" lê melhor do que a queixa de campo ausente.
 */
function semCamposVazios(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input

  const copia: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const campo of OPCIONAIS) {
    if (typeof copia[campo] === 'string' && copia[campo].trim() === '') delete copia[campo]
  }
  return copia
}

export async function submitLeadAction(
  slug: string,
  input: unknown,
): Promise<LeadFormState> {
  const parsed = SiteLeadInputSchema.safeParse(semCamposVazios(input))
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Confira os campos destacados.',
      fieldErrors: parsed.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? 'form'),
        message: issue.message,
      })),
    }
  }

  const headerBag = await headers()
  const forwarded = headerBag.get('x-forwarded-for')?.split(',')[0]?.trim()

  return submitLead(slug, parsed.data, {
    // `unknown` em vez de vazio: o serviço conta por IP, e um IP vazio faria todos os
    // visitantes sem cabeçalho dividirem a mesma cota.
    ip: forwarded ?? headerBag.get('x-real-ip') ?? 'unknown',
    userAgent: headerBag.get('user-agent'),
  })
}
