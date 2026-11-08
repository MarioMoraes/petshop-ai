import { Skeleton } from '@/components/skeleton'

/**
 * O Início.
 *
 * Não tem `PageHeader`: quem faz esse papel é a saudação, que mora na moldura e já está
 * na tela. O esqueleto desenha a composição da Aurora — quatro números, a semana com a
 * agenda à direita, e os dois cartões de baixo —, na mesma grade de doze colunas.
 */
export default function Loading() {
  return (
    <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-12 xl:grid-rows-[auto_318px_auto]">
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:col-span-12 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[148px] rounded-[28px]" />
        ))}
      </div>
      <Skeleton className="h-[318px] rounded-[28px] xl:col-span-8" />
      <Skeleton className="h-[318px] rounded-[28px] xl:col-span-4 xl:row-span-2 xl:h-auto" />
      <Skeleton className="h-[206px] rounded-[28px] xl:col-span-4" />
      <Skeleton className="h-[206px] rounded-[28px] xl:col-span-4" />
    </div>
  )
}
