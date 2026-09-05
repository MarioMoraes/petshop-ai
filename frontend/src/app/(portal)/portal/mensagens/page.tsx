import { redirect } from 'next/navigation'
import type { PortalMessagesResponse, PortalPreferencesResponse } from '@petshop/shared-types'
import { PortalFrame } from '../frame'
import { Lista } from './lista'
import { Preferencias } from './preferencias'
import {
  PortalError,
  readOwnMessages,
  readOwnPreferences,
  readPortalContext,
} from '@/lib/portal-api'

/**
 * Central de Comunicação (MOD-PORTAL-10).
 *
 * A tela responde duas perguntas, nesta ordem: **o que vocês me mandaram** e **o que eu
 * quero continuar recebendo**. A ordem não é arbitrária — quem abre esta tela chegou
 * por uma das duas, e quem chegou pela segunda passa pela primeira e vê exatamente o
 * tipo de mensagem que está prestes a desligar.
 *
 * As duas seções têm gates diferentes no servidor: a lista é `crm:read_own`, as
 * preferências são `tutor:read_own`. Consentimento é dado da ficha do tutor, e não do
 * módulo de mensageria — é lá que a prova jurídica mora.
 */

export const dynamic = 'force-dynamic'

export default async function PortalMensagensPage() {
  let context
  let mensagens: PortalMessagesResponse
  let preferencias: PortalPreferencesResponse

  try {
    ;[context, mensagens, preferencias] = await Promise.all([
      readPortalContext(),
      readOwnMessages({ limit: 10 }),
      readOwnPreferences(),
    ])
  } catch (error) {
    // Vínculo revogado ou sessão que deixou de valer: volta para a porta, como as
    // outras telas do Portal, em vez de mostrar erro a quem só precisa entrar de novo.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Mensagens"
      descricao={`O que o ${context.tenant.name} enviou para você.`}
      voltar={{ href: '/portal/inicio', label: 'Início' }}
    >
      <Lista inicial={mensagens} />
      <Preferencias inicial={preferencias} />
    </PortalFrame>
  )
}
