import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ler } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { Precos } from './precos'

/**
 * A tabela de preços (camada comercial).
 *
 * **O que se muda aqui é o preço de quem chega.** Quem já assina tem o valor congelado na
 * própria assinatura, no banco e no Asaas — e essa escolha é o que esta tela precisa dizer
 * em voz alta, porque é a pergunta que quem mexe no preço faz em seguida.
 *
 * A landing acompanha sem deploy: ela lê `/api/planos`, que lê esta mesma tabela.
 */

export const dynamic = 'force-dynamic'

export default async function PlanosPage() {
  const leitura = await ler(serverApi().listPlanPrices())
  if (leitura.estado === 'fechado') return <SemAcesso />

  return (
    <PlataformaShell active="planos">
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Planos"
          subtitle="O preço vale para quem assinar a partir de agora. Quem já assina continua pagando o que contratou."
        />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A tabela não veio" mensagem={leitura.mensagem} />
        ) : (
          <Precos itens={leitura.dado.items} />
        )}
      </div>
    </PlataformaShell>
  )
}
