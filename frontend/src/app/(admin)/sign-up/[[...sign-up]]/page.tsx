import { SignUp } from '@clerk/nextjs'
import { parsePlanParam } from '@petshop/shared-types'
import { AuthSplit } from '@/components/auth-split'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  /*
   * O plano escolhido na landing (`/sign-up?plan=pro`) atravessa o Clerk pelo destino do
   * fim do cadastro: o formulário dele não devolve a query de onde veio, e sem isto a
   * escolha se perdia no primeiro clique. É só a sugestão inicial — quem cria o
   * estabelecimento ainda confirma o plano na etapa 2 do wizard.
   */
  const plan = parsePlanParam((await searchParams).plan)
  const destino = plan ? `/onboarding?plan=${plan.toLowerCase()}` : undefined

  return (
    <main>
      {/*
        A promessa de tempo é a do onboarding real: o assistente de quatro etapas
        (MOD-IDENT-02). Se ele crescer, esta frase precisa encolher junto.
      */}
      <AuthSplit chamada="Crie sua conta e configure o petshop em menos de 10 minutos.">
        <SignUp {...(destino ? { fallbackRedirectUrl: destino } : {})} />
      </AuthSplit>
    </main>
  )
}
