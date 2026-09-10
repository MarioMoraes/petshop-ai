import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A ficha do pet — cabeçalho, resumo e as seções do prontuário. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={5} />
        <CardSkeleton lines={4} />
      </div>
    </>
  )
}
