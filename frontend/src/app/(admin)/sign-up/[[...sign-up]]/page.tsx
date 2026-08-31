import { SignUp } from '@clerk/nextjs'
import { AuthSplit } from '@/components/auth-split'

export default function SignUpPage() {
  return (
    <main>
      {/*
        A promessa de tempo é a do onboarding real: o assistente de cinco etapas
        (MOD-IDENT-02). Se ele crescer, esta frase precisa encolher junto.
      */}
      <AuthSplit chamada="Crie sua conta e configure o petshop em menos de 10 minutos.">
        <SignUp />
      </AuthSplit>
    </main>
  )
}
