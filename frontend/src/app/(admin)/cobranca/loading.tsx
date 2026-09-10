import { CardSkeleton, PageHeaderSkeleton, Skeleton } from '@/components/skeleton'

/** Os relatórios: cabeçalho, a fila de filtros e a tabela. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 flex flex-wrap gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-36 rounded-2xl" />
        ))}
      </div>
      <div className="mt-4">
        <CardSkeleton lines={8} />
      </div>
    </>
  )
}
