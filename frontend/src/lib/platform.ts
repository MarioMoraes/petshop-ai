import 'server-only'
import { ApiError } from '@petshop/api-client'

/**
 * A leitura do console da plataforma, e o que fazer quando ela é recusada.
 *
 * **O gate desta superfície não está aqui — está no backend**, e é o mesmo para todas as
 * nove rotas: token do Clerk **sem** Organization mais linha viva em `platform_admins`.
 * Quem não passa recebe 404, e não 403, porque um 403 confirmaria a quem está varrendo
 * que existe uma equipe de plataforma (RN-01 de MOD-ADMIN-01).
 *
 * O console honra essa escolha: 404 não vira tela de erro, vira o cartão neutro de
 * `<SemAcesso>`, que diz a mesma coisa a quem é da equipe e a quem não é. É por isso que
 * a leitura devolve um estado em vez de lançar — a página decide o que mostrar, e nenhuma
 * página precisa saber por que a porta estava fechada.
 *
 * **A primeira leitura de cada tela é o gate.** Não há uma chamada extra para perguntar
 * "posso?": a resposta da própria consulta responde as duas coisas, e uma pergunta a mais
 * por página seria uma ida ao banco por página para descobrir o que a seguinte diria de
 * graça.
 */

export type Leitura<T> =
  /** A porta abriu. */
  | { estado: 'ok'; dado: T }
  /**
   * 404: ou não há linha em `platform_admins`, ou o token veio com Organization ativa.
   * As duas caem aqui, e o cartão não distingue — distinguir seria contar quem é da casa.
   */
  | { estado: 'fechado' }
  /** A API respondeu, mas com falha. O texto é o do problema, para a tela mostrar. */
  | { estado: 'erro'; mensagem: string }

export async function ler<T>(promessa: Promise<T>): Promise<Leitura<T>> {
  try {
    return { estado: 'ok', dado: await promessa }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { estado: 'fechado' }
      return { estado: 'erro', mensagem: error.message }
    }
    throw error
  }
}

/**
 * As leituras secundárias de uma tela, que já passou pelo gate na primeira.
 *
 * Falha para `null`: um painel que perde a segunda consulta mostra a primeira, e não uma
 * página de erro. É a mesma regra do sino de pendências do Admin.
 */
export async function talvez<T>(promessa: Promise<T>): Promise<T | null> {
  return promessa.catch(() => null)
}
