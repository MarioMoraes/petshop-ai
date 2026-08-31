import { redirect } from 'next/navigation'

/** `/financeiro` não é tela: é o atalho para a primeira aba. */
export default function FinanceiroIndex() {
  redirect('/financeiro/pacotes')
}
