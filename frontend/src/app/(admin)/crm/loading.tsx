import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** O painel de mensagens: cabeçalho e os cartões da fila. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>
    </>
  )
}
