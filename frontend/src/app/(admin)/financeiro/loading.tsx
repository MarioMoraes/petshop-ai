import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** Pacotes e políticas: cabeçalho, a lista e o painel de configuração. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
      </div>
    </>
  )
}
