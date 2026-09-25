import { ListSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A forma de `/estoque/vendas`: cabeçalho e a lista das vendas. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-6">
        <ListSkeleton rows={8} />
      </div>
    </>
  )
}
