import Link from 'next/link'
import { Card, Logo } from '@/components/ui'

export default function NotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 px-4">
      <Logo />
      <Card className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">Página não encontrada</h1>
        <p className="hint mt-3">O endereço que você abriu não existe ou foi movido.</p>
        <Link href="/" className="btn btn-primary mt-6">
          Voltar ao início
        </Link>
      </Card>
    </main>
  )
}
