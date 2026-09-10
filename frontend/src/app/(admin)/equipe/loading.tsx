import { ListSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A equipe: cabeçalho e a lista de quem tem acesso. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-10">
        <ListSkeleton rows={4} />
      </div>
    </>
  )
}
