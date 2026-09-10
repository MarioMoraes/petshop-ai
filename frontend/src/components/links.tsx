'use client'

import type { ReactNode } from 'react'
import Link, { useLinkStatus } from 'next/link'
import { SpinnerIcon, type IconTone } from './icons'

/**
 * Links que sabem que foram clicados.
 *
 * A barra do topo (`route-progress.tsx`) diz que **alguma coisa** está sendo buscada.
 * Estes dizem **qual**: o item de menu que ficou girando é o destino, e num sistema em
 * que todas as telas custam uma ida ao servidor essa diferença é a que evita o segundo
 * clique — em outro item, que descarta o primeiro e recomeça a espera.
 *
 * O mecanismo é o `useLinkStatus` do Next, que só responde **dentro** de um `<Link>`. É
 * por isso que a peça girante é sempre um filho, e nunca o próprio link: quem pergunta
 * pelo estado precisa estar embaixo de quem navega.
 */

/**
 * O slot que troca de conteúdo enquanto a navegação está no ar.
 *
 * Caixa de tamanho fixo: sob `prefers-reduced-motion` o `SpinnerIcon` se esconde (é a
 * decisão do próprio ícone), e sem a caixa o rótulo ao lado daria um salto de 20px para
 * a esquerda toda vez que alguém clicasse.
 */
export function LinkSpinner({
  children,
  size = 20,
  className = '',
}: {
  /** O que fica no slot em repouso — o ícone do domínio, o chevron da linha. */
  children: ReactNode
  size?: number
  className?: string
}) {
  const { pending } = useLinkStatus()

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {pending ? <SpinnerIcon size={size} /> : children}
    </span>
  )
}

/**
 * Item do menu lateral.
 *
 * O tom não muda com o estado — azul é Agenda em repouso, em hover, ativa e carregando.
 * O que muda é o desenho: o ícone do domínio dá lugar ao giro e volta quando a tela chega.
 */
export function NavLink<T extends string>({
  href,
  label,
  icon,
  tone,
  active,
}: {
  href: Parameters<typeof Link<T>>[0]['href']
  label: string
  icon: ReactNode
  tone: IconTone
  active: boolean
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`nav-item ${active ? 'nav-item-active' : ''}`}
    >
      <LinkSpinner className={`icon-tint ${tone}`}>{icon}</LinkSpinner>
      {label}
    </Link>
  )
}

/**
 * O mesmo item na faixa de bolso — abaixo de `lg`, onde a lateral não cabe.
 *
 * Sem ícone: a faixa rola na horizontal e cada glifo custaria um item a menos visível.
 * O anel entra à esquerda do rótulo e alarga a pastilha enquanto dura; numa faixa que já
 * rola, alargar não desarruma nada.
 */
export function NavPill<T extends string>({
  href,
  label,
  active,
}: {
  href: Parameters<typeof Link<T>>[0]['href']
  label: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`btn btn-ghost shrink-0 px-3 py-1.5 ${active ? 'bg-card text-ink' : ''}`}
    >
      <LinkSpinnerVazio />
      {label}
    </Link>
  )
}

/**
 * O `<Link>` com cara de botão.
 *
 * Mesma peça do `<Button>` de `ui.tsx` vista do outro lado: lá o botão espera o backend
 * responder, aqui o link espera a próxima tela chegar. Quem clica não distingue os dois
 * casos, e por isso a resposta visual é a mesma.
 */
export function ButtonLink<T extends string>({
  href,
  variant = 'primary',
  className = '',
  icon,
  active,
  children,
}: {
  href: Parameters<typeof Link<T>>[0]['href']
  variant?: 'primary' | 'accent' | 'ghost'
  className?: string
  /** Glifo à esquerda do rótulo. É ele que dá lugar ao giro, quando existe. */
  icon?: ReactNode
  /**
   * O botão é a tela em que se está — o filtro escolhido, a aba aberta.
   *
   * Só a marcação: quem pinta o escolhido é a `variant`, porque numa fila de filtros o
   * contraste precisa ser o do próprio botão. `aria-current` é o que diz a mesma coisa
   * a quem não vê a fila, e sem ele o leitor de tela lê seis links iguais.
   */
  active?: boolean
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`btn btn-${variant} ${className}`}
    >
      {icon ? (
        <LinkSpinner size={16}>{icon}</LinkSpinner>
      ) : (
        // Sem glifo, o giro entra à esquerda do rótulo e o botão cresce um pouco. Numa
        // barra de ações isso mexe com o vizinho; num botão solto, ninguém nota — e o
        // preço de reservar 16px em repouso em **todo** botão seria pior.
        <LinkSpinnerVazio />
      )}
      {children}
    </Link>
  )
}

/** O giro que só ocupa lugar enquanto existe. */
function LinkSpinnerVazio() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return <SpinnerIcon />
}
