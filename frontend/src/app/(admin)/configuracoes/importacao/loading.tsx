import { CardSkeleton, PageHeaderSkeleton } from '@/components/skeleton'

/**
 * A importação: cabeçalho, a nota de como funciona e os quatro passos.
 *
 * Esqueleto próprio, e não o da porta das Configurações: o irmão desenha cartões de
 * navegação em duas colunas, e esta tela é uma pilha de passos na largura inteira. Um
 * esqueleto que não se parece com o que vai chegar é pior do que nenhum.
 */
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="mt-10 space-y-5">
        {Array.from({ length: 5 }, (_, index) => (
          <CardSkeleton key={index} lines={index === 0 ? 2 : 3} />
        ))}
      </div>
    </>
  )
}
