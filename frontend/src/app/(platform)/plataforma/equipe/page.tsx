import { PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ler } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { Equipe } from './gestao'

/**
 * A equipe da plataforma (MOD-ADMIN-01).
 *
 * `SUPER_ADMIN` estava na matriz de permissões desde o MOD-IDENT-04, com um comentário
 * prometendo um `support_access_grant` que ninguém tinha escrito: um papel declarado e
 * inalcançável, sem rota que o reconhecesse e sem tabela que o registrasse. Esta tela é o
 * fim daquela promessa — e o fim do `psql` como forma de entrar na plataforma.
 */

export const dynamic = 'force-dynamic'

export default async function EquipePage() {
  const leitura = await ler(serverApi().listPlatformAdmins())
  if (leitura.estado === 'fechado') return <SemAcesso />

  return (
    <PlataformaShell active="equipe">
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Equipe"
          subtitle="Conceder e revogar ficam registrados na trilha da plataforma, como toda escrita daqui."
        />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A lista não veio" mensagem={leitura.mensagem} />
        ) : (
          <Equipe admins={leitura.dado.items} />
        )}
      </div>
    </PlataformaShell>
  )
}
