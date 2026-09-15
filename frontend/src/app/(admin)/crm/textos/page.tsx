import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { carregarMe, serverApi } from '@/lib/api'
import { TemplatesEditor } from './templates-editor'

/**
 * Os textos que saem para o cliente (MOD-CRM-02).
 *
 * O AC-01 pede que o admin abra a tela e **encontre os textos prontos** — não uma
 * lista vazia com "criar template". Ele os encontra: o catálogo vive em código
 * (`messaging-seed.ts`) e o banco guarda só o que o petshop reescreveu, então esta
 * tela mostra sempre as oito combinações de texto × canal, customizadas ou não.
 *
 * Editar aqui **não** reescreve o que já está na fila: o corpo é renderizado na
 * entrada (RN-14). Trocar o texto às 20h não muda o lembrete que sai às 8h — e isso é
 * proposital, porque a mensagem que o tutor recebeu precisa continuar sendo a que o
 * histórico mostra.
 */

export const dynamic = 'force-dynamic'

export default async function TextosPage() {
  const [me, templates] = await Promise.all([
    carregarMe(),
    serverApi()
      .listMessageTemplates()
      .then((response) => response.data)
      .catch((error: unknown) => {
        if (error instanceof ApiError) return error
        throw error
      }),
  ])

  const canConfigure = me.permissions.includes('crm:configure')

  if (templates instanceof ApiError) {
    return (
      <div className="space-y-6">
        <Header canConfigure={canConfigure} />
        <EmptyState
          title="O serviço não respondeu"
          description="O serviço de mensagens está indisponível agora. Recarregue em instantes."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header canConfigure={canConfigure} />
      <TemplatesEditor templates={templates} canConfigure={canConfigure} />
    </div>
  )
}

/**
 * Sem `crm:configure` a tela abre em leitura, e não fechada.
 *
 * É a mesma escolha de `/configuracoes`: a recepção tem motivo legítimo para consultar
 * o texto que sai — ela é quem ouve "recebi uma mensagem estranha" — e negar a leitura
 * não protege nada que a própria mensagem já não tenha entregado ao cliente.
 */
function Header({ canConfigure }: { canConfigure: boolean }) {
  return (
    <PageHeader
      eyebrow={
        <Link href="/crm" className="hover:underline">
          ← Mensagens
        </Link>
      }
      title="Textos"
      subtitle={
        canConfigure
          ? 'O que o cliente recebe em cada situação'
          : 'O que o cliente recebe em cada situação — só o administrador edita'
      }
      actions={<ButtonLink href="/crm/configuracoes">Configuração</ButtonLink>}
    />
  )
}
