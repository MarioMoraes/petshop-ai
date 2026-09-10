import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronRightIcon, type IconTone } from '@/components/icons'
import { LinkSpinner } from '@/components/links'

/**
 * A lista do Portal — o cartão com linhas dentro.
 *
 * Existe porque as seis telas do tutor listavam coisas de seis jeitos: cartões soltos
 * empilhados com 12px de respiro em Meus pets e nos horários, `border-b` seco dentro de
 * um cartão no extrato, nas mensagens e nos documentos. Nenhum dos dois tinha relevo, e
 * o segundo nem afordância — a linha do documento levava a um PDF e parecia texto.
 *
 * A física mora em `globals.css` (§ pilha de linhas do Portal); o que está aqui é a
 * marcação, e a regra de quando cada peça entra:
 *
 * - `RowStack` é o cartão. `head` é o cabeçalho de seção, no padrão do `SectionHead`.
 * - `RowLink` é a linha que leva a algum lugar — dentro do app, ou a um arquivo que abre
 *   em outra aba. Ela levanta sob o dedo e mostra o chevron.
 * - `RowItem` é a linha de leitura, que não leva a lugar nenhum e por isso **não** pode
 *   reagir ao dedo que só está rolando a tela.
 * - `RowChip` é o ícone do tipo, na cor do domínio.
 * - `RowText` é o par título/legenda, com o riscado de quem foi cancelado ou estornado.
 */

export function RowStack({
  head,
  children,
  footer,
}: {
  /** Cabeçalho da seção — normalmente um `<SectionHead>`. */
  head?: ReactNode
  /** As linhas. Opcional porque a lista vazia é só o cabeçalho, com a frase no lugar. */
  children?: ReactNode
  /** O "ver mais", o aviso de rodapé: o que fecha o cartão sem ser uma linha da lista. */
  footer?: ReactNode
}) {
  return (
    <section className="card menu-stack">
      {head && <div className="px-3 pt-2 pb-3">{head}</div>}
      {children}
      {footer && <div className="px-3 pt-3 pb-2">{footer}</div>}
    </section>
  )
}

/**
 * O ícone do tipo, no chip de 36px.
 *
 * O tom é o do assunto e nunca o do estado — o calendário é azul no horário de amanhã e
 * no de março passado. Quem marca estado nesta lista é a palavra ("Cancelado") ou a cor
 * do valor, nunca o chip.
 */
export function RowChip({ icon, tone }: { icon: ReactNode; tone: IconTone }) {
  return <span className={`icon-chip icon-chip-sm shrink-0 ${tone}`}>{icon}</span>
}

export function RowText({
  title,
  hint,
  strike = false,
  children,
}: {
  title: ReactNode
  hint?: ReactNode
  /** Cancelado, estornado: o que foi desfeito continua na lista, riscado. */
  strike?: boolean
  /** Uma terceira linha — o leva-e-traz do horário, o link do recibo. */
  children?: ReactNode
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className={`block text-sm font-semibold ${strike ? 'text-muted line-through' : ''}`}>
        {title}
      </span>
      {hint && <span className="hint block">{hint}</span>}
      {children}
    </span>
  )
}

/**
 * A linha que navega dentro do app. O chevron vem de graça.
 *
 * Genérica no `href` como o `<Link>` é: sem o parâmetro de tipo, uma rota montada por
 * template (`/portal/pets/${id}`) não passa pelo `typedRoutes`, e a única saída seria um
 * `as` que desliga justamente a checagem que ele existe para fazer.
 */
export function RowLink<T extends string>({
  href,
  top = false,
  children,
}: {
  href: Parameters<typeof Link<T>>[0]['href']
  top?: boolean
  children: ReactNode
}) {
  return (
    <Link href={href} className={`menu-row ${top ? 'menu-row-top' : ''}`}>
      {children}
      {/*
        O chevron é o slot da espera: ele já é a promessa de que a linha leva a algum
        lugar, e trocá-lo pelo anel enquanto a tela vem é responder no mesmo canto onde a
        promessa foi feita. A caixa é fixa para a linha não encolher quando ele some sob
        `prefers-reduced-motion`.
      */}
      <span className="menu-chevron shrink-0">
        <LinkSpinner size={16}>
          <ChevronRightIcon />
        </LinkSpinner>
      </span>
    </Link>
  )
}

/**
 * A linha que abre um arquivo.
 *
 * `<a>` cru e não `<Link>`: o destino é uma rota que responde com bytes, e o roteador do
 * Next tentaria navegar para ela. `target="_blank"` porque o PDF aberto no lugar da
 * lista deixaria o tutor sem o botão de voltar em metade dos celulares.
 */
export function RowFile({
  href,
  top = false,
  children,
}: {
  href: string
  top?: boolean
  children: ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`menu-row ${top ? 'menu-row-top' : ''}`}
    >
      {children}
      <span className="menu-chevron shrink-0">
        <ChevronRightIcon />
      </span>
    </a>
  )
}

/** A linha de leitura. Não levanta, não tem chevron, não promete nada. */
export function RowItem({ top = false, children }: { top?: boolean; children: ReactNode }) {
  return <li className={`menu-row ${top ? 'menu-row-top' : ''}`}>{children}</li>
}

/**
 * O valor, o selo, a hora — o que fecha a linha pela direita.
 *
 * Alinhado à direita e sem encolher: numa lista de dinheiro, os algarismos precisam
 * cair na mesma coluna, senão a leitura vertical que o extrato existe para permitir se
 * perde.
 */
export function RowMeta({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-right text-sm font-medium">{children}</span>
}
