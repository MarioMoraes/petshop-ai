import { FormSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** A assinatura: cabeçalho, a ficha do plano e a do pagamento. */
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
