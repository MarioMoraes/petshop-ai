import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ShieldCheckIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { ImportacaoPanel } from './importacao-panel'

/**
 * Importar a base do sistema anterior (MOD-IMPORT).
 *
 * O gate é `import:run`, e não a soma de `tutor:create` + `pet:create` +
 * `schedule:manage_catalog`: uma tacada cria clientes, animais, equipe e agenda de uma
 * vez, e o desfazer desmonta o que ela criou. É decisão de virada de sistema, do mesmo
 * peso que configurar o estabelecimento.
 *
 * A checagem daqui é de experiência — quem manda é o `requirePermission` do backend.
 * Sem ela, a tela abriria e só falharia no primeiro clique.
 */

export const dynamic = 'force-dynamic'

export default async function ImportacaoPage() {
  const me = await carregarMe()
  if (!me.permissions.includes('tenant:read_settings')) redirect('/dashboard')

  const podeImportar = me.permissions.includes('import:run')

  const [entities, batches] = await Promise.all([
    podeImportar ? serverApi().listImportEntities() : Promise.resolve({ items: [] }),
    // O histórico é moldura: uma falha de leitura não pode derrubar a tela inteira junto
    // com ele — quem chega aqui vem para subir um arquivo.
    podeImportar
      ? serverApi()
          .listImportBatches()
          .catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] }),
  ])

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/configuracoes" className="hover:underline">
            ← Configurações
          </Link>
        }
        title="Importar dados"
        subtitle="Traga tutores, pets, profissionais e agendamentos do sistema anterior. Escolher o arquivo só confere — nada é gravado até você aplicar."
      />

      <div className="mt-10">
        {!podeImportar ? (
          <EmptyState
            icon={<ShieldCheckIcon />}
            tone="icon-system"
            title="Sem permissão para importar"
            description="Trazer a base de outro sistema cria clientes, animais, equipe e agenda de uma vez. A ação é do administrador do estabelecimento — peça a ele."
          />
        ) : (
          <ImportacaoPanel entities={entities.items} batches={batches.items} />
        )}
      </div>
    </>
  )
}
