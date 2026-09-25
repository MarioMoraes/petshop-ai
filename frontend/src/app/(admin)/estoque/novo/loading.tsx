import { FormSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A forma do cadastro: cabeçalho e as três fichas. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-6">
        <FormSkeleton sections={3} />
      </div>
    </>
  )
}
