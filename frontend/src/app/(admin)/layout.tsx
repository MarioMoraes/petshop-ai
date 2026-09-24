import type { Metadata } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'
import { ptBR } from '@clerk/localizations'
import { ToastProvider } from '@/components/toast'
import '../globals.css'

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
 * Layout raiz **do Admin**, e não do aplicativo inteiro.
 *
 * O `app/` tem dois raízes: `(admin)` e `(site)`. Cada um traz o próprio `<html>`, e é
 * essa separação que faz valer a decisão do roteamento por host: o `ClerkProvider`
 * daqui carrega o SDK de identidade no browser, e o site público do petshop — anônimo,
 * cacheado, aberto ao mundo — não tem por que pagar esse JavaScript nem receber cookie
 * de sessão de quem opera o estabelecimento. Um layout só obrigaria as duas coisas.
 *
 * O Clerk é o provedor de identidade da aplicação (SPEC §5), em pt-BR — o público-alvo
 * é pouco digitalizado, e tela de login em inglês é fricção logo na porta de entrada.
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
        {/*
          `suppressHydrationWarning`: o `<body>` é o único nó do app que só renderiza
          uma vez, e é onde extensão de navegador (gerenciador de senha, Grammarly,
          dark mode) injeta atributo antes do React hidratar — o React compara contra
          um HTML que a própria aplicação nunca alterou. Só ignora divergência neste
          nó; não propaga para os filhos, então não mascara mismatch de verdade.
        */}
        <body suppressHydrationWarning>
          <ToastProvider>{children}</ToastProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
