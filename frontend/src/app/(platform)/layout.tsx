import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { ptBR } from '@clerk/localizations'
import '../globals.css'

/**
 * Layout raiz **do console da plataforma**, quarto irmão de `(admin)`, `(site)` e
 * `(portal)`.
 *
 * O `app/` divide as raízes por público, e este é o quarto:
 *
 * ```
 * (admin)    app.{dominio}                   a equipe do petshop
 * (site)     petshopdojoao.{dominio}/        o visitante anônimo
 * (portal)   petshopdojoao.{dominio}/portal  o cliente do petshop
 * (platform) app.{dominio}/plataforma        a equipe da PetShop AI
 * ```
 *
 * **Divide o host com o Admin e não o layout**, e a diferença importa: a moldura de lá
 * lê `/v1/me`, resolve permissões do tenant corrente e monta um menu de estabelecimento.
 * Quem entra aqui não tem estabelecimento nenhum — a sessão da plataforma é justamente a
 * que não traz Organization —, e herdar aquele shell faria toda tela começar por um erro
 * de contexto que não existe.
 *
 * O `ClerkProvider` é o mesmo de sempre, da **mesma** instância: um diretório de usuários
 * só. Quem separa as sessões é a resolução do papel, no backend, e nunca o provedor.
 *
 * `noindex`: é área interna. O `robots` do Admin não a alcançaria — cada raiz declara os
 * próprios metadados.
 */

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'PetShop AI — Plataforma',
  robots: { index: false, follow: false },
}

export default function PlatformRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      localization={ptBR}
      appearance={{
        variables: {
          colorPrimary: '#171719',
          colorText: '#232427',
          colorBackground: '#ffffff',
          borderRadius: '14px',
        },
      }}
    >
      <html lang="pt-BR" className={`${inter.variable} ${instrumentSerif.variable}`}>
        <body suppressHydrationWarning>{children}</body>
      </html>
    </ClerkProvider>
  )
}
