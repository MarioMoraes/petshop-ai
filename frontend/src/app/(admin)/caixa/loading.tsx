import { PageHeaderSkeleton, Skeleton } from '@/components/skeleton'

/** A forma de `/caixa`: cabeçalho, a faixa de números e os dois cartões. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="mt-6 h-64 w-full rounded-2xl" />
    </>
  )
}
