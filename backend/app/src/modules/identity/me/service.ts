import { withTenant } from '@petshop/db'

/**
 * A marca de lido do sino — a única do produto.
 *
 * O sino do Admin mostra trabalho parado, e cinco das suas seis fontes zeram sozinhas
 * quando alguém faz o trabalho. A sexta — o agendamento que o tutor marcou no Portal —
 * não tem trabalho a fazer: ele já está confirmado e já está na agenda. Sem um "até
 * onde eu já vi", o contador ficaria aceso para sempre.
 *
 * Ela vive em `memberships` e **por vínculo**, não por usuário: quem atende dois
 * estabelecimentos tem duas caixas de entrada, e uma marca global faria a visita ao
 * primeiro apagar o aviso do segundo.
 */

/**
 * Até quando esta pessoa já viu, neste estabelecimento. `null` é quem nunca abriu.
 *
 * Sem cache, de propósito. As permissões ao lado passam por Redis porque mudam raro;
 * esta muda a cada abertura do sino, e um valor de 300s atrás faria o contador voltar
 * a acender depois de a pessoa já ter olhado.
 */
export async function readPortalBookingsSeenAt(
  tenantId: string,
  userId: string,
): Promise<Date | null> {
  return withTenant(tenantId, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { tenantId, userId },
      select: { portalBookingsSeenAt: true },
    })
    return membership?.portalBookingsSeenAt ?? null
  })
}

/**
 * Marca o instante da abertura.
 *
 * **O instante é o de agora, e não o do agendamento mais recente.** A diferença
 * aparece na corrida: um tutor que marca enquanto o painel está aberto entraria como
 * já visto se a marca fosse a do último agendamento conhecido pela tela. Com `now()`
 * no servidor, o que nasce depois da abertura continua sendo novidade.
 *
 * Não incrementa `permVersion` nem invalida cache de permissão: a coluna não participa
 * de decisão de acesso nenhuma, e forçar refresh de token por causa dela derrubaria a
 * sessão de todo mundo a cada abertura do sino.
 */
export async function markPortalBookingsSeen(tenantId: string, userId: string): Promise<Date> {
  const agora = new Date()
  await withTenant(tenantId, async (tx) => {
    await tx.membership.updateMany({
      where: { tenantId, userId },
      data: { portalBookingsSeenAt: agora },
    })
  })
  return agora
}
