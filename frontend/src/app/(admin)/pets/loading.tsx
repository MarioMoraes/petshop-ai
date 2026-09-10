import { ListSkeleton, PageHeaderSkeleton, Skeleton } from '@/components/skeleton'

/** A forma de `/pets`: cabeçalho, busca, as pastilhas de espécie e a pilha de linhas. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="mt-8 h-11 w-full rounded-2xl" />
      <div className="mt-3 flex gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-20 rounded-full" />
        ))}
      </div>
      <div className="mt-4">
        <ListSkeleton />
      </div>
    </>
  )
}
