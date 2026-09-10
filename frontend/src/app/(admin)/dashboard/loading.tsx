import { Skeleton } from '@/components/skeleton'

/**
 * O Início.
 *
 * Não tem `PageHeader`: quem faz esse papel é a saudação da faixa, que mora na moldura e
 * já está na tela. O esqueleto começa direto no gráfico e nas faixas de números.
 */
export default function Loading() {
  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <Skeleton className="h-3 w-28 rounded-full" />
        <Skeleton className="h-48 w-full rounded-3xl" />
      </div>

      {Array.from({ length: 2 }, (_, faixa) => (
        <div key={faixa} className="space-y-3">
          <Skeleton className="h-3 w-24 rounded-full" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, cartao) => (
              <Skeleton key={cartao} className="h-28 rounded-3xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
