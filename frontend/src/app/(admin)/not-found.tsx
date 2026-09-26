import { Card, Logo } from '@/components/ui'
import { ButtonLink } from '@/components/links'

export default function NotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 px-4">
      <Logo />
      <Card className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">Página Não Encontrada</h1>
        <p className="hint mt-3">O endereço que você abriu não existe ou foi movido.</p>
        <ButtonLink href="/" className="mt-6">
          Voltar ao início
        </ButtonLink>
      </Card>
    </main>
  )
}
