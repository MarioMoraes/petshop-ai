import { PageHeaderSkeleton, RecordGridSkeleton, Skeleton } from '@/components/skeleton'

/** A forma de `/pets`: cabeçalho, busca, as pílulas de espécie e a grade de cartões. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="mt-6 h-12 w-full rounded-2xl" />
      <div className="mt-3 flex gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      <div className="mt-6">
        <RecordGridSkeleton />
      </div>
    </>
  )
}
