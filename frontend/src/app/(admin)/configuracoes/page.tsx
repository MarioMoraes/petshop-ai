import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRightIcon, SettingsIcon, UploadIcon, WalletIcon } from '@/components/icons'
import type { IconTone } from '@/components/icons'
import { PageHeader } from '@/components/ui'
import { carregarMe } from '@/lib/api'
import type { PermissionKey } from '@petshop/shared-types'
import type { ReactNode } from 'react'

/**
 * A porta das Configurações.
 *
 * Três destinos, e não três abas: o que o menu chamava de "Configurações" abria direto
 * na ficha do estabelecimento, e Assinatura vivia num botão no canto do cabeçalho — um
 * lugar que só se encontra depois de já estar na tela errada. A importação da base seria
 * a décima aba de uma faixa que já quebrava em duas linhas com nove.
 *
 * Cada cartão é um assunto inteiro, com público e frequência próprios: a ficha do
 * estabelecimento se visita de vez em quando, a assinatura uma vez por ciclo, e a
 * importação uma vez na vida da conta. Amontoá-los numa faixa de abas faria o de uma vez
 * na vida disputar espaço com o de todo mês.
 *
 * O recorte por permissão mora aqui, e não no menu: `tenant:read_settings` já abriu a
 * seção; o que cada cartão exige é dele. Cartão que levaria a um 403 não aparece — link
 * que devolve o usuário ao início é pior que link nenhum.
 */

export const dynamic = 'force-dynamic'

interface Destino {
  href: '/configuracoes/estabelecimento' | '/assinatura' | '/configuracoes/importacao'
  icon: ReactNode
  tone: IconTone
  eyebrow: string
  title: string
  description: string
  requires: PermissionKey
}

const DESTINOS: Destino[] = [
  {
    href: '/configuracoes/estabelecimento',
    icon: <SettingsIcon />,
    tone: 'icon-system',
    eyebrow: 'Estabelecimento',
    title: 'Configurações',
    description:
      'Dados do petshop, horário de funcionamento, políticas de agendamento, identidade visual, catálogo de raças, privacidade e trilha de auditoria.',
    requires: 'tenant:read_settings',
  },
  {
    href: '/assinatura',
    icon: <WalletIcon />,
    tone: 'icon-money',
    eyebrow: 'Plano',
    title: 'Assinatura',
    description: 'O plano contratado, o que ele inclui, a forma de pagamento e a próxima cobrança.',
    requires: 'tenant:configure',
  },
  {
    href: '/configuracoes/importacao',
    icon: <UploadIcon />,
    tone: 'icon-system',
    eyebrow: 'Virada de sistema',
    title: 'Importar dados',
    description:
      'Traga tutores, pets, profissionais e agendamentos do sistema anterior, a partir das planilhas que ele exporta.',
    requires: 'import:run',
  },
]

export default async function ConfiguracoesPage() {
  const me = await carregarMe()

  // Sem sequer poder ler, a seção não existe para este perfil. Voltar ao início é mais
  // honesto que um 403 numa rota que o menu nem deveria ter oferecido.
  if (!me.permissions.includes('tenant:read_settings')) redirect('/dashboard')

  const destinos = DESTINOS.filter((destino) => me.permissions.includes(destino.requires))

  return (
    <>
      <PageHeader
        eyebrow="Estabelecimento"
        title="Configurações"
        subtitle="O que é do petshop e não do dia a dia: como ele funciona, o plano que sustenta a conta e a base que veio de antes."
      />

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {destinos.map((destino) => (
          <Link
            key={destino.href}
            href={destino.href}
            className="card group flex items-start gap-4 p-6 transition-shadow hover:shadow-lg sm:p-7"
          >
            <span className={`icon-chip ${destino.tone} shrink-0`}>{destino.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="section-eyebrow block">{destino.eyebrow}</span>
              <span className="section-title mt-0.5 block">{destino.title}</span>
              <span className="hint mt-2 block">{destino.description}</span>
            </span>
            <span className="mt-1 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5">
              <ChevronRightIcon />
            </span>
          </Link>
        ))}
      </div>
    </>
  )
}
