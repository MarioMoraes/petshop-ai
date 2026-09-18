import { PageHeaderSkeleton, Skeleton, SkeletonLine } from '@/components/skeleton'

/**
 * A porta das Configurações: cabeçalho e os cartões de destino.
 *
 * O esqueleto mostra três — é o que o administrador vê, e quem tem menos permissão vê
 * um a menos por um instante. Desenhar dois para não arriscar mostraria a tela
 * encolhendo depois de carregar, que é o defeito que o esqueleto existe para evitar.
 */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="card flex items-start gap-4 p-6 sm:p-7">
            <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <SkeletonLine w="w-24" />
              <SkeletonLine w="w-40" className="mt-2 h-4" />
              <SkeletonLine className="mt-3" />
              <SkeletonLine w="w-2/3" className="mt-1.5" />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
