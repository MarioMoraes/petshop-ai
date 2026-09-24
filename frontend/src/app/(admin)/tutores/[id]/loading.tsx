import { CardSkeleton, RecordHeroSkeleton, Skeleton } from '@/components/skeleton'

/**
 * A ficha: o herói, o trilho de abas e os grupos da aba Dados.
 *
 * É a navegação em que o esqueleto mais rende: sair da lista para a ficha mantém menu,
 * faixa e largura no lugar, e só o miolo troca — que é exatamente o que ele desenha.
 */
export default function Loading() {
  return (
    <>
      <RecordHeroSkeleton />
      <Skeleton className="mt-6 h-11 w-96 max-w-full rounded-full" />
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={4} />
      </div>
    </>
  )
}
