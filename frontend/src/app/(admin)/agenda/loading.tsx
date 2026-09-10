import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A agenda: cabeçalho, a fila de dias e o quadro do dia. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8">
        <CardSkeleton lines={6} />
      </div>
    </>
  )
}
