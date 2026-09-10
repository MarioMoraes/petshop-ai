import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** O quadro do leva-e-traz: cabeçalho e os cartões das corridas do dia. */
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
