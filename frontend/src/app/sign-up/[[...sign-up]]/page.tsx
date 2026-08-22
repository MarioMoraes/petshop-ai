import { SignUp } from '@clerk/nextjs'
import { Logo } from '@/components/ui'

export default function SignUpPage() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 px-4">
      <Logo />
      <p className="hint max-w-sm text-center">
        Crie sua conta e configure o petshop em menos de 10 minutos.
      </p>
      <SignUp />
    </main>
  )
}
