import { CardSkeleton, RecordHeroSkeleton } from '@/components/skeleton'

/** A ficha do produto: o herói, a tabela de lotes e o histórico. */
export default function Loading() {
  return (
    <>
      <RecordHeroSkeleton />
      <div className="mt-6 space-y-6">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={5} />
      </div>
    </>
  )
}
