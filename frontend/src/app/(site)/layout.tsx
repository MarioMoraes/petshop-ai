import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import '../globals.css'

/**
 * Layout raiz **do site público**, irmão do `(admin)/layout.tsx`.
 *
 * A diferença entre os dois é o que este arquivo **não** tem: `ClerkProvider`. A
 * página do petshop é anônima, cacheada e aberta ao mundo; carregar nela o SDK de
 * identidade custaria JavaScript no 4G da calçada e poria cookie de sessão na mesma
 * origem que serve conteúdo público — exatamente o que a divisão por host
 * (`lib/host.ts`) existe para evitar.
 *
 * As fontes são as mesmas: um petshop com identidade própria ainda é uma página do
 * produto, e `next/font` as auto-hospeda — sem requisição a domínio externo no caminho
 * crítico.
 */

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
})

/**
 * O metadado real sai de `generateMetadata` na página, com o nome e a cidade do
 * petshop. Este é só o rótulo de fallback — e o `noindex` do layout não existe de
 * propósito: quem decide o que o buscador vê é a página, que sabe se o site está
 * publicado.
 */
export const metadata: Metadata = {
  title: 'Pet shop',
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${instrumentSerif.variable}`}>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
