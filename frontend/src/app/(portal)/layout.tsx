import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { ptBR } from '@clerk/localizations'
import '../globals.css'

/**
 * Layout raiz **do Portal do Tutor**, terceiro irmão de `(admin)` e `(site)`.
 *
 * O `app/` tem três raízes, cada um com o próprio `<html>`, e a divisão é por público:
 *
 * ```
 * (admin)  app.{dominio}                  a equipe do petshop
 * (site)   petshopdojoao.{dominio}/       o visitante anônimo
 * (portal) petshopdojoao.{dominio}/portal o cliente do petshop
 * ```
 *
 * O `ClerkProvider` volta aqui — o tutor se autentica —, mas a instância é a **mesma**
 * do Admin, por decisão de 2026-09-03: um diretório de usuários só, o que resolve sem
 * segunda conta o caso do funcionário que também é cliente. O que separa os dois não é
 * o provedor de identidade, é a resolução da sessão: no Portal o papel sai de
 * `tutors.portal_user_id`, nunca de `memberships`.
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
 * O nome do petshop entra no título pela página, que sabe qual é. Este é o rótulo de
 * reserva — e o `noindex` é do Portal inteiro: é área de cliente, não tem por que
 * aparecer em buscador nenhum.
 */
export const metadata: Metadata = {
  title: 'Portal do Tutor',
  robots: { index: false, follow: false },
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
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
