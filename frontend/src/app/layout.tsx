import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { ptBR } from '@clerk/localizations'
import './globals.css'

/**
 * As fontes vêm por `next/font`, que as auto-hospeda: sem requisição a um domínio
 * externo no caminho crítico e sem o salto de layout que o carregamento tardio causa.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'PetShop AI — Admin',
  description: 'Gestão completa do seu petshop: tutores, pets, agenda e financeiro.',
}

/**
 * O Clerk é o provedor de identidade de toda a aplicação (SPEC §5), em pt-BR — o
 * público-alvo é pouco digitalizado, e tela de login em inglês é fricção logo na
 * porta de entrada.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
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
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
