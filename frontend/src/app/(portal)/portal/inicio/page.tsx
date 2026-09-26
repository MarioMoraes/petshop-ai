import Link from 'next/link'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { SignOutButton } from '@clerk/nextjs'
import { formatBRL, portalCreditCents, portalOwesCents, titleCase } from '@petshop/shared-types'
import {
  CalendarIcon,
  ChevronRightIcon,
  DocumentIcon,
  IdCardIcon,
  InboxIcon,
  PawPrintIcon,
  WalletIcon,
  type IconTone,
} from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { PortalFrame } from '../frame'
import { PortalError, readPortalContext } from '@/lib/portal-api'
import { Button } from '@/components/ui'

/**
 * O início do Portal.
 *
 * A fatia 1 entregou a **porta**, e esta tela era a prova de que ela abre. Com a fatia
 * 2 ela vira o que devia ser: o desvio para os pets, que é o que o tutor veio buscar.
 *
 * **O cartão "em breve" saiu com o MOD-PORTAL-10**, e não por descuido: ele existia
 * para que quem entrasse e não encontrasse o que procurava não concluísse que o acesso
 * falhou. A última promessa dele — rever as mensagens — virou tela, e um cartão vazio
 * anunciando nada faria a tela terminar num silêncio esquisito. Se uma fatia futura
 * voltar a prometer algo, o cartão volta com ela.
 *
 * A tela é **uma ação e um menu**, e não uma pilha de botões. Enquanto era uma pilha,
 * "Marcar horário" era um botão escuro no meio de cinco botões fantasma — e uma peça
 * chapada entre transparentes lê como *item selecionado*, não como item importante. O
 * tutor abria Meus pets, voltava, e o topo da lista continuava aceso como se ele
 * estivesse ali. A separação resolve pela estrutura, e não por um ajuste de cor: ação é
 * ação, destino é destino.
 *
 * **O cartão de resumo saiu em 2026-09-08**, a pedido: dois números — pets cadastrados e
 * saldo — ocupavam o primeiro terço da tela para dizer o que as próprias linhas do menu
 * já levam. O saldo era o único deles que não podia sumir, e virou o subtítulo de
 * "Minha conta"; a contagem de pets não voltou, porque quem quer saber quantos são abre
 * a lista.
 */

export const dynamic = 'force-dynamic'

/**
 * Os destinos do menu, na ordem em que o tutor precisa deles.
 *
 * O tom do ícone é o do domínio no Admin — o calendário é azul aqui como é na Agenda —,
 * porque quem atende no balcão e quem usa o Portal falam do mesmo assunto, e a cor é o
 * que faz a linha ser reconhecida antes de ser lida.
 *
 * `href` em união literal e não `string`: é o `typedRoutes` do Next que transforma um
 * link para tela inexistente em erro de compilação. Mesma escolha do `NavItem` do
 * `AppShell` e do `voltar` do `PortalFrame`.
 */
const MENU: {
  href:
    | '/portal/agendamentos'
    | '/portal/pets'
    | '/portal/financeiro'
    | '/portal/mensagens'
    | '/portal/documentos'
    | '/portal/dados'
  label: string
  hint: string
  icon: ReactNode
  tone: IconTone
}[] = [
  {
    href: '/portal/agendamentos',
    label: 'Meus agendamentos',
    hint: 'Ver, remarcar ou cancelar',
    icon: <CalendarIcon />,
    tone: 'icon-time',
  },
  {
    href: '/portal/pets',
    label: 'Meus pets',
    hint: 'Ficha, histórico e vacinas',
    icon: <PawPrintIcon />,
    tone: 'icon-pet',
  },
  {
    href: '/portal/financeiro',
    label: 'Minha conta',
    hint: 'Extrato, pacotes e recibos',
    icon: <WalletIcon />,
    tone: 'icon-money',
  },
  {
    href: '/portal/mensagens',
    label: 'Mensagens',
    hint: 'O que o petshop te enviou',
    icon: <InboxIcon />,
    tone: 'icon-brand',
  },
  /*
    "Meus documentos" fica ao lado de mensagens e antes de "meus dados": é o lugar de
    buscar um papel — o recibo do mês passado, o receituário do gato —, e não o de
    corrigir cadastro.
  */
  {
    href: '/portal/documentos',
    label: 'Meus documentos',
    hint: 'Receituários e comprovantes',
    icon: <DocumentIcon />,
    tone: 'icon-system',
  },
  /*
    "Meus dados" é o último da lista, e não por ordem de chegada: é o que se abre quando
    alguma coisa está errada, e não o que se vem fazer.
  */
  {
    href: '/portal/dados',
    label: 'Meus dados',
    hint: 'Contato, endereço e privacidade',
    icon: <IdCardIcon />,
    tone: 'icon-people',
  },
]

export default async function PortalInicioPage() {
  let context
  try {
    context = await readPortalContext()
  } catch (error) {
    // Vínculo revogado ou sessão que deixou de valer: volta para a porta, em vez de
    // mostrar uma tela de erro a quem só precisa entrar de novo.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  /**
   * **Negativo é dívida** (RN-02 do MOD-LEDGER), e esta tela já leu ao contrário: até a
   * fatia 4 ela comparava `saldo > 0` com "Em aberto" e dizia "Sem pendências" a quem
   * devia. As duas funções vêm do pacote compartilhado justamente para que a conversão
   * não seja refeita, e reinvertida, em cada tela nova.
   */
  const deve = portalOwesCents(context.tutor.balanceCents)
  const credito = portalCreditCents(context.tutor.balanceCents)

  /*
   * O saldo desceu para a linha "Minha conta" quando o cartão de resumo saiu da tela.
   * Ele não podia sair junto: uma dívida em aberto é a única coisa nesta tela que a
   * pessoa precisa ver sem procurar, e ela agora aparece onde já estava o caminho para
   * resolvê-la — em vermelho, que é o único lugar do menu onde a cor diz estado e não
   * assunto. Sem dívida e sem crédito, a linha volta a descrever o destino.
   */
  const saldo =
    deve > 0
      ? `${formatBRL(deve)} em aberto`
      : credito > 0
        ? `${formatBRL(credito)} de crédito`
        : null

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo={`Olá, ${primeiroNome(context.tutor.name)}`}
      descricao="Seu acesso está ativo."
    >
      {/*
        Marcar horário é a única ação da tela, e por isso mora sozinha acima do menu: é o
        que a pessoa vem fazer — consultar a ficha se faz uma vez, marcar banho se faz
        todo mês. Fora da lista ela pode ser escura sem que a lista pareça ter um item
        ligado.
      */}
      {context.features.onlineBookingEnabled && (
        <ButtonLink href="/portal/agendar" className="h-12 w-full text-[0.9375rem]">
          Marcar horário
        </ButtonLink>
      )}

      <nav aria-label="Menu do portal" className="card menu-stack">
        {MENU.map((item) => (
          <Link key={item.href} href={item.href} className="menu-row">
            {/* O tom é do assunto, não do estado: nada aqui fica "aceso". */}
            <span className={`icon-chip icon-chip-sm shrink-0 ${item.tone}`}>{item.icon}</span>

            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{titleCase(item.label)}</span>
              <span
                className={`hint block truncate ${
                  deve > 0 && item.href === '/portal/financeiro' ? 'text-danger font-medium' : ''
                }`}
              >
                {(item.href === '/portal/financeiro' ? saldo : null) ?? item.hint}
              </span>
            </span>

            <span className="menu-chevron shrink-0">
              <ChevronRightIcon />
            </span>
          </Link>
        ))}
      </nav>

      {/*
        O "Sair" fecha a tela, e fora do menu: sair não é um destino do Portal, é o fim
        da visita. Fica aqui e não no rodapé de toda tela porque o Início é onde a visita
        termina — e sem ele o Portal não teria saída nenhuma, rodando como roda no
        celular de família, que passa de mão em mão.
      */}
      <SignOutButton redirectUrl="/portal/entrar">
        <Button type="button" variant="ghost" className="w-full">
          Sair
        </Button>
      </SignOutButton>
    </PortalFrame>
  )
}

function primeiroNome(nome: string): string {
  return nome.split(' ')[0] ?? nome
}
