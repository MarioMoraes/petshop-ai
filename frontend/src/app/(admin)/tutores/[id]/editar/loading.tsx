import { FormSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** O cadastro: cabeçalho e as fichas `card-soft` com os campos. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8">
        <FormSkeleton sections={2} fields={3} />
      </div>
    </>
  )
}
