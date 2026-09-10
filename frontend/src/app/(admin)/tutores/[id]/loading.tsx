import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/**
 * A ficha do tutor.
 *
 * É a navegação em que o esqueleto mais rende: sair da lista para a ficha mantém menu,
 * faixa e largura no lugar, e só o miolo troca — que é exatamente o que ele desenha.
 */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-8 space-y-4">
        <CardSkeleton lines={5} />
        <CardSkeleton lines={3} />
      </div>
    </>
  )
}
