import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** O painel: cabeçalho, a faixa de números e as duas listas. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={2} />
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
      </div>
    </>
  )
}
