import Link from 'next/link'
import { rotuloDoDia } from '@/lib/agenda-dia'

/**
 * O Mural sem agenda para mostrar — serviço fora do ar ou papel sem `schedule:read_all`.
 *
 * Fica no escuro do Mural e não no cartão claro do Admin de propósito: quem abriu esta
 * aba pediu uma tela, e devolver a moldura de erro do outro host seria dizer que a aba
 * está no lugar errado. A saída daqui é um link para a Agenda do Dia, na mesma aba —
 * lá o mesmo 403 vem acompanhado do menu, que é por onde a pessoa segue trabalhando.
 */
export function MuralVazio({
  date,
  titulo,
  descricao,
}: {
  date: string
  titulo: string
  descricao: string
}) {
  return (
    <div className="mural mural-centro">
      <div className="mural-aviso">
        <p className="mural-eyebrow">Mural do dia</p>
        <h1 className="mural-aviso-titulo">{titulo}</h1>
        <p className="mural-aviso-texto">{descricao}</p>
        <p className="mural-aviso-texto mural-aviso-data">{rotuloDoDia(date)}</p>
        <Link href={`/agenda/dia?date=${date}`} className="mural-acao mural-acao-forte">
          Ir para a Agenda do Dia
        </Link>
      </div>
    </div>
  )
}
