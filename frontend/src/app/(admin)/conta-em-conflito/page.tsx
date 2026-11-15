import { SignOutButton } from '@clerk/nextjs'
import { AlertTriangleIcon } from '@/components/icons'
import { Button, Logo, Shell } from '@/components/ui'

/**
 * Quem entrou com uma conta do Clerk cujo e-mail já pertence a outro usuário.
 *
 * O backend recusa `/v1/me` com 409 (RN-12 do MOD-IDENT): não há como adivinhar qual
 * das duas contas é a legítima. `carregarMe` desvia para cá, e esta tela **não chama a
 * API** — chamá-la levaria ao mesmo 409. A saída é sair e entrar com a conta original;
 * sem este botão a pessoa ficava presa no "Application error", sem como deslogar.
 */
export default function ContaEmConflitoPage() {
  return (
    <Shell>
      <header className="flex items-center px-6 py-5 sm:px-10">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:px-10">
        <div className="card max-w-lg p-6 text-center sm:p-8">
          <span className="icon-chip icon-chip-sm icon-system mx-auto">
            <AlertTriangleIcon />
          </span>
          <h1 className="mt-4 text-xl font-semibold">Este E-mail Já Tem Outra Conta</h1>
          <p className="hint mx-auto mt-2 max-w-sm">
            Você entrou com uma conta nova, mas o e-mail dela já está ligado a outra conta do
            PetShop AI. Saia e entre do mesmo jeito que costuma entrar — com o mesmo e-mail e o
            mesmo método (senha, código ou Google).
          </p>
          <div className="mt-6 flex justify-center">
            <SignOutButton redirectUrl="/sign-in">
              <Button type="button">Sair e Entrar com Outra Conta</Button>
            </SignOutButton>
          </div>
        </div>
      </main>
    </Shell>
  )
}
