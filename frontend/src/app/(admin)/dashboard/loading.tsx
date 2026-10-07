import { Skeleton } from '@/components/skeleton'
import { STAT_GRID, STAT_SHAPE } from './stat-grid'

/**
 * O Início.
 *
 * Não tem `PageHeader`: quem faz esse papel é a saudação da faixa, que mora na moldura e
 * já está na tela. O esqueleto começa direto nas faixas.
 *
 * A grade é a mesma da página — a mesma `STAT_GRID` e a mesma forma de
 * `STAT_SHAPE` —, e as faixas com o tamanho que elas têm: o Movimento e o Financeiro com
 * três cartões, a Sua base com dois.
 */
export default function Loading() {
  return (
    <div>
      {[3, 3, 2].map((cartoes, faixa) => (
        <section key={faixa} className="mt-8 first:mt-0">
          <Skeleton className="h-3 w-24 rounded-full" />
          <div className={`mt-4 ${STAT_GRID}`}>
            {Array.from({ length: cartoes }, (_, cartao) => (
              <Skeleton key={cartao} className={`rounded-3xl ${STAT_SHAPE}`} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
