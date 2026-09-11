import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A fila: cabeçalho, as abas e as linhas de conversa. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    </>
  )
}
