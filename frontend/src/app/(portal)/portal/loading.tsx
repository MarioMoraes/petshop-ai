import { ColumnSkeleton } from '@/components/skeleton'

/**
 * O Portal inteiro.
 *
 * Aqui o esqueleto vale para a tela toda, e não só para o miolo: a moldura do Portal
 * (`frame.tsx`) é montada por cada página, com o próprio título e o próprio link de
 * voltar — não há menu lateral a preservar. A coluna estreita com as linhas **é** a
 * forma de todas as telas do tutor, então o desenho continua fiel.
 */
export default function Loading() {
  return <ColumnSkeleton />
}
