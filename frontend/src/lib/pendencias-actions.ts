'use server'

import { serverApi } from './api'

/**
 * A marca de lido do sino, do lado do servidor.
 *
 * **Arquivo próprio, e não uma função a mais em `pendencias.server.ts`.** Aquele é
 * `server-only` — existe justamente para não poder ser importado do browser. Uma
 * Server Action é o contrário: precisa ser importável do componente client, que é
 * quem a chama. Os dois marcadores não convivem no mesmo arquivo.
 */

/**
 * "Já vi os agendamentos novos do Portal."
 *
 * Server Action, e não uma chamada do browser ao gateway: o token do Clerk e o endereço
 * interno do backend ficam no servidor, como em todo o resto do Admin.
 *
 * **Engole o erro de propósito.** A pior consequência de a marca não gravar é o aviso
 * reaparecer na próxima navegação. Trocar isso por uma tela de erro, sobre um clique
 * que ninguém pediu, seria péssimo negócio.
 */
export async function marcarAgendamentosVistos(): Promise<void> {
  await serverApi()
    .markPortalBookingsSeen()
    .catch(() => null)
}
