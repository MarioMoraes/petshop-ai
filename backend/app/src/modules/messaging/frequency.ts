import type { TenantTransaction } from '@petshop/db'

/**
 * O teto semanal de marketing, por tutor.
 *
 * É a resposta à questão 5 do §11 do PRD, dada pelo dono do produto: **uma mensagem de
 * marketing por tutor a cada sete dias**.
 *
 * Vale a pena separar do que já existia, porque os três tetos do módulo protegem coisas
 * diferentes e é fácil confundi-los:
 *
 * - `perMinuteCap` protege o **provedor** — rajada uniforme é assinatura de robô;
 * - `dailyCap` protege o **número do petshop** — quinhentas mensagens num dia é
 *   banimento pedido;
 * - este protege o **tutor**, que é quem cansa. Um cliente com três pets, taxi e débito
 *   entra em quatro seleções na mesma semana sem que nenhum dos outros dois perceba, e a
 *   RN-08 agrupa cinco minutos, o que nada faz contra o acúmulo ao longo de dias.
 *
 * A janela é **corrida**, não a semana do calendário: sete dias contados para trás a
 * partir de agora. Semana de calendário deixaria passar duas mensagens em trinta horas —
 * sábado e domingo — e depois trancaria o tutor por seis dias.
 */

const WINDOW_DAYS = 7

/**
 * Os estados que contam.
 *
 * Contam as que **saíram** e as que ainda **vão sair**. Incluir a fila é o que impede
 * duas campanhas enfileiradas no mesmo dia de passarem as duas — cada uma olharia para
 * um histórico em que a outra ainda não apareceu. `BLOCKED`, `CANCELLED`, `DEAD` e
 * `MERGED` ficam de fora: nenhuma delas chegou ao tutor, e cobrar o teto por uma
 * mensagem que ele nunca viu é o mesmo que reduzir o teto sem avisar ninguém.
 */
const COUNTED = ['QUEUED', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'READ'] as const

export function windowStart(now: Date): Date {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 3_600_000)
}

/**
 * O tutor já gastou a cota da semana?
 *
 * `cap` zero desliga a regra — e a checagem explícita evita a leitura acidental de que
 * zero significa "nenhuma mensagem permitida", que seria o oposto do que a configuração
 * diz na tela.
 *
 * `excludeMessageId` existe para a revalidação no despacho: lá a própria mensagem já
 * está gravada e contaria contra si mesma.
 */
export async function marketingCapReached(
  tx: TenantTransaction,
  options: { tutorId: string; cap: number; now: Date; excludeMessageId?: string },
): Promise<boolean> {
  if (options.cap <= 0) return false

  const count = await tx.message.count({
    where: {
      tutorId: options.tutorId,
      direction: 'OUTBOUND',
      category: 'MARKETING',
      status: { in: [...COUNTED] },
      createdAt: { gte: windowStart(options.now) },
      ...(options.excludeMessageId ? { id: { not: options.excludeMessageId } } : {}),
    },
  })

  return count >= options.cap
}
