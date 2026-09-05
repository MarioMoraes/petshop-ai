import { redirect } from 'next/navigation'
import type { PortalMeDataResponse } from '@petshop/shared-types'
import { PortalFrame } from '../frame'
import { MeusDados } from './meus-dados'
import { PortalError, readOwnData, readPortalContext } from '@/lib/portal-api'

/**
 * Meus Dados (MOD-PORTAL-09).
 *
 * A última tela do Portal, e a que fecha o módulo. Ela responde três perguntas em ordem
 * de frequência: **o que vocês têm sobre mim**, **como corrijo o que está errado** e **como
 * saio daqui** — e é essa ordem que o desenho segue, com o pedido de exclusão por último e
 * discreto, sem ser escondido.
 *
 * As três seções têm caminhos de escrita diferentes, e a diferença é a substância do
 * módulo: nome social e nascimento gravam direto; telefone e e-mail passam por um código
 * enviado ao contato **novo**; o pedido de exclusão não grava nada na ficha — vira uma
 * linha numa fila que a equipe do petshop vê.
 */

export const dynamic = 'force-dynamic'

export default async function PortalDadosPage({
  searchParams,
}: {
  searchParams: Promise<{ exportacao?: string }>
}) {
  let context
  let dados: PortalMeDataResponse

  try {
    ;[context, dados] = await Promise.all([readPortalContext(), readOwnData()])
  } catch (error) {
    // Vínculo revogado ou sessão que deixou de valer: volta para a porta, como as outras
    // telas do Portal, em vez de mostrar erro a quem só precisa entrar de novo.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const { exportacao } = await searchParams

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Meus dados"
      descricao={`O que o ${context.tenant.name} tem no seu cadastro.`}
      voltar={{ href: '/portal/inicio', label: 'Início' }}
    >
      <MeusDados
        inicial={dados}
        tenantName={context.tenant.name}
        falhaNaExportacao={exportacao === 'erro'}
      />
    </PortalFrame>
  )
}
