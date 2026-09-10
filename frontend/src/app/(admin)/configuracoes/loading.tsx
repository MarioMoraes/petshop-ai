import { FormSkeleton, PageHeaderSkeleton, Skeleton } from '@/components/skeleton'

/** As configurações: cabeçalho, a faixa de abas e a ficha da aba aberta. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-10 flex flex-wrap gap-2 border-b border-line pb-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-24 rounded-full" />
        ))}
      </div>
      <div className="mt-6">
        <FormSkeleton sections={2} fields={3} />
      </div>
    </>
  )
}
