'use server'

import { headers } from 'next/headers'
import { SiteLeadInputSchema, type FieldError } from '@petshop/shared-types'
import { submitLead, type LeadResult } from '@/lib/site-api'

/**
 * O envio do formulário público.
 *
 * Passa por Server Action, e não por `fetch` do browser: o `tenant-site-service` não é
 * publicado pela borda (o Caddy entrega só o Next), então o browser não teria como
 * alcançá-lo — e não precisa. O IP do visitante é lido aqui e repassado ao serviço,
 * que é quem aplica o teto de três envios por quinze minutos.
 */

export interface LeadFormState extends LeadResult {
  fieldErrors?: FieldError[]
}

export async function submitLeadAction(
  slug: string,
  input: unknown,
): Promise<LeadFormState> {
  const parsed = SiteLeadInputSchema.safeParse(input)
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
