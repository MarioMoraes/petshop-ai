/**
 * Esqueletos — o desenho da tela antes do dado chegar.
 *
 * Entram pelos `loading.tsx`, e só valem onde a **moldura já está montada**: o limite de
 * suspensão que o `loading.tsx` cria embrulha a página, não o layout irmão. Ir de Tutores
 * para a Agenda troca as duas coisas ao mesmo tempo e quem responde é a barra do topo
 * (`route-progress.tsx`); ir da lista de tutores para a ficha de um deles mantém menu,
 * faixa e largura no lugar, e aí o esqueleto é o que diz onde o conteúdo vai nascer.
 *
 * A regra que os mantém úteis: **esqueleto imita a forma que vai chegar**. Três blocos
 * genéricos no lugar de uma lista de dez linhas fazem a tela saltar quando o dado chega,
 * que é o defeito que o esqueleto existia para evitar. Quando a forma da tela não couber
 * em nenhum destes, escreva o `loading.tsx` dela à mão com `<Skeleton>` — é a peça crua.
 */

/** O bloco cru. `className` traz a caixa; a pintura e o varrimento vêm de `.skeleton`. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton block ${className}`} />
}

/** Uma linha de texto. `w` é a largura, em fração da coluna. */
export function SkeletonLine({ w = 'w-full', className = '' }: { w?: string; className?: string }) {
  return <Skeleton className={`h-3.5 rounded-full ${w} ${className}`} />
}

/**
 * O cabeçalho de página, na forma do `<PageHeader>`: olho-de-boi, título grande e
 * subtítulo. O botão da direita não entra — nem toda tela tem um, e um retângulo
 * fantasma no canto onde não vai nascer nada é pior que o vazio.
 */
export function PageHeaderSkeleton({ eyebrow = true }: { eyebrow?: boolean }) {
  return (
    <div className="space-y-3">
      {eyebrow && <Skeleton className="h-3 w-24 rounded-full" />}
      <Skeleton className="h-9 w-64 max-w-full rounded-xl" />
      <SkeletonLine w="w-80 max-w-full" />
    </div>
  )
}

/**
 * Grade de cartões de registro — a forma de `/pets` e `/tutores`
 * (`components/record-list.tsx`): rosto, duas linhas e o pé separado por um fio.
 */
export function RecordGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
      {Array.from({ length: cards }, (_, index) => (
        <li key={index} className="card flex flex-col gap-4 p-5">
          <div className="flex items-start gap-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <SkeletonLine w="w-36 max-w-full" />
              <SkeletonLine w="w-48 max-w-full" className="h-3" />
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-line pt-3.5">
            <SkeletonLine w="w-32" className="h-3" />
            <SkeletonLine w="w-20" className="h-3" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Lista de cartões-linha — a forma de `/equipe`.
 *
 * Seis linhas: a página pede vinte, mas o esqueleto não precisa preencher a rolagem, e
 * uma coluna de vinte fantasmas parece congestionamento, não espera.
 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="card flex items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine w="w-48 max-w-full" />
            <SkeletonLine w="w-32 max-w-full" className="h-3" />
          </div>
          <Skeleton className="h-3 w-16 rounded-full" />
        </li>
      ))}
    </ul>
  )
}

/** Cartão branco de conteúdo com N linhas dentro. O detalhe é feito destes. */
export function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="card space-y-3 p-6 sm:p-8">
      <Skeleton className="h-5 w-40 max-w-full rounded-lg" />
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex items-baseline justify-between gap-6 py-1">
          <SkeletonLine w="w-28" className="h-3" />
          <SkeletonLine w="w-40 max-w-[50%]" />
        </div>
      ))}
    </div>
  )
}

/**
 * Ficha de formulário — o `Card tone="soft"` com o chip do `SectionHead` e os campos.
 *
 * O chip redondo entra porque ele é a âncora da leitura vertical do formulário: sem ele o
 * esqueleto seria uma pilha de retângulos que não se parece com o que vai chegar.
 */
export function FormSkeleton({ sections = 2, fields = 3 }: { sections?: number; fields?: number }) {
  return (
    <div className="space-y-5">
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="card card-soft space-y-5 p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-2.5 w-20 rounded-full" />
              <Skeleton className="h-4 w-44 max-w-full rounded-lg" />
            </div>
          </div>
          {Array.from({ length: fields }, (_, campo) => (
            <div key={campo} className="space-y-2">
              <Skeleton className="h-3 w-24 rounded-full" />
              <Skeleton className="h-11 w-full rounded-2xl" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** A moldura estreita do Portal e do console: cabeçalho da coluna e as linhas embaixo. */
export function ColumnSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 px-5 py-10">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24 rounded-full" />
        <Skeleton className="h-8 w-52 max-w-full rounded-xl" />
      </div>
      <div className="card menu-stack">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="menu-row">
            <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonLine w="w-40 max-w-full" />
              <SkeletonLine w="w-24" className="h-3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
