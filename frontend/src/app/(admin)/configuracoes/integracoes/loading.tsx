import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/** Integrações: cabeçalho e uma pilha de seções na largura inteira, como a tela. */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-10 space-y-6">
        {Array.from({ length: 3 }, (_, index) => (
          <CardSkeleton key={index} lines={3} />
        ))}
      </div>
    </>
  )
}
