import { redirect } from 'next/navigation'
import type { PortalDocumentsResponse, PortalTermsResponse } from '@petshop/shared-types'
import { PortalFrame } from '../frame'
import { Documentos } from './documentos'
import { Termos } from './termos'
import { PortalError, listOwnDocuments, listOwnTerms, readPortalContext } from '@/lib/portal-api'

/**
 * Meus documentos (MOD-DOC-10) e os termos que o tutor aceita (MOD-DOC-07 e 08).
 *
 * A tela responde duas perguntas, nesta ordem: **o que já é meu** e **o que falta eu
 * aceitar**. A ordem é a mesma da Central de Comunicação, e pelo mesmo motivo — quem
 * chega pela segunda passa pela primeira e vê que o papel do aceite anterior está ali,
 * guardado, antes de assinar o próximo.
 *
 * **A lista é filtrada por titularidade, não por tipo** (AC-03): recibo, receituário e
 * termo saem da mesma tabela e chegam juntos. Documento interno do estabelecimento não
 * tem titular e por isso nem é consultado — assim um tipo novo não vaza por esquecimento.
 */

export const dynamic = 'force-dynamic'

export default async function PortalDocumentosPage({
  searchParams,
}: {
  searchParams: Promise<{ documento?: string }>
}) {
  let context
  let documentos: PortalDocumentsResponse
  let termos: PortalTermsResponse

  try {
    ;[context, documentos, termos] = await Promise.all([
      readPortalContext(),
      listOwnDocuments(),
      listOwnTerms(),
    ])
  } catch (error) {
    // Vínculo revogado ou sessão que deixou de valer: volta para a porta, como as outras
    // telas do Portal, em vez de mostrar erro a quem só precisa entrar de novo.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const { documento } = await searchParams

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Meus documentos"
      descricao={`Os papéis que o ${context.tenant.name} emitiu para você, e os termos que você aceitou.`}
      voltar={{ href: '/portal/inicio', label: 'Início' }}
    >
      <Documentos documentos={documentos.documents} aviso={documento ?? null} />
      <Termos termos={termos.terms} />
    </PortalFrame>
  )
}
