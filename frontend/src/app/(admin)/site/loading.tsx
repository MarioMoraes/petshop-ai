import { FormSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** O site do estabelecimento: cabeçalho e as fichas do formulário. */
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
