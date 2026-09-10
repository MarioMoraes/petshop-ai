/**
 * Quando um clique num link é, de fato, uma navegação a sinalizar.
 *
 * A barra de progresso do topo (`components/route-progress.tsx`) escuta o clique no
 * `document` inteiro, porque o App Router não publica evento de início de navegação —
 * `usePathname` só muda quando a resposta já chegou, que é o fim, não o começo.
 *
 * Escutar tudo obriga a saber recusar. Um `Cmd+clique` abre outra aba e a aba atual não
 * vai a lugar nenhum; um link para fora do app tira a página do React inteiro; um
 * `download` nem sai da tela. Acender a barra nesses casos é pior do que não ter barra:
 * ela sobe, trava e some sozinha, e a partir da segunda vez ninguém mais acredita nela.
 *
 * A decisão vive aqui, fora do componente, porque é a única parte que tem regra — o
 * resto é montagem — e porque assim ela se testa em ambiente node, sem DOM.
 */

/** O que a barra precisa saber do evento. Um `MouseEvent` cabe aqui como está. */
export interface CliqueDeLink {
  defaultPrevented: boolean
  /** 0 é o botão principal; 1 é o do meio, que abre em outra aba. */
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** O que a barra precisa saber da âncora. Um `HTMLAnchorElement` cabe aqui como está. */
export interface LinkClicado {
  /** Já absoluto — é o que a propriedade `href` de uma âncora devolve. */
  href: string
  target: string
  /** `true` quando o atributo `download` está presente. */
  download: boolean
}

export function deveSinalizar(link: LinkClicado, urlAtual: string, clique: CliqueDeLink): boolean {
  // Alguém já tratou o clique — um menu que abre, um handler que chama `preventDefault`.
  if (clique.defaultPrevented) return false

  // Botão do meio abre em outra aba; direito abre o menu de contexto.
  if (clique.button !== 0) return false

  // Os modificadores que abrem noutro lugar. Shift abre em outra janela, Alt baixa o
  // arquivo, Ctrl/Cmd abre em outra aba — em nenhum deles esta página se mexe.
  if (clique.metaKey || clique.ctrlKey || clique.shiftKey || clique.altKey) return false

  if (link.download) return false
  if (link.target && link.target !== '_self') return false
  if (!link.href) return false

  let destino: URL
  let atual: URL
  try {
    destino = new URL(link.href)
    atual = new URL(urlAtual)
  } catch {
    // `mailto:`, `tel:`, `blob:` e o que mais não for URL navegável.
    return false
  }

  // Protocolo que não é o da web sai da aplicação — ou nem sai da tela.
  if (destino.protocol !== 'http:' && destino.protocol !== 'https:') return false

  // Outro domínio é outra aplicação: quem pinta o carregamento é o navegador.
  if (destino.origin !== atual.origin) return false

  // Mesma rota. Inclui a âncora interna (`#secao`), que rola a página e não busca nada.
  if (destino.pathname === atual.pathname && destino.search === atual.search) return false

  return true
}
