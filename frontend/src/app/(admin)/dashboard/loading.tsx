import { Skeleton } from '@/components/skeleton'
import { STAT_GRID, STAT_MIN_HEIGHT } from './stat-grid'

/**
 * O Início.
 *
 * Não tem `PageHeader`: quem faz esse papel é a saudação da faixa, que mora na moldura e
 * já está na tela. O esqueleto começa direto nas faixas.
 *
 * A grade é a mesma da página — três colunas, `gap-5`, a altura mínima do cartão de
 * número —, e as duas primeiras faixas com o tamanho que elas têm: o Movimento numa
 * linha (o gráfico é um cartão como os outros) e a Sua base em duas. Um esqueleto de
 * quatro colunas baixas trocava de forma inteira quando os números chegavam.
 */
export default function Loading() {
  return (
    <div>
      {[3, 6].map((cartoes, faixa) => (
        <section key={faixa} className="mt-8 first:mt-0">
          <Skeleton className="h-3 w-24 rounded-full" />
          <div className={`mt-4 ${STAT_GRID}`}>
            {Array.from({ length: cartoes }, (_, cartao) => (
              <Skeleton key={cartao} className={`rounded-3xl ${STAT_MIN_HEIGHT}`} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
