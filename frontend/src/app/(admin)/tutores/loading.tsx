import { ListSkeleton, PageHeaderSkeleton, Skeleton } from '@/components/skeleton'

/** A forma de `/tutores`: cabeçalho, caixa de busca e a pilha de cartões-linha. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="mt-8 h-11 w-full rounded-2xl" />
      <div className="mt-4">
        <ListSkeleton />
      </div>
    </>
  )
}
