import { getMaintenancePrisma } from '@petshop/db'
import { publishEvent } from '../../../shared/events.js'
import { logger } from '../../../shared/logger.js'

/**
 * O aviso da véspera do fim do teste (camada comercial).
 *
 * **O que existia era só o corte.** `runExpireTrialsOnce` virava a chave na hora marcada
 * e o estabelecimento descobria pela tela travada, no meio do expediente, sem nunca ter
 * sido avisado de que aquele dia chegaria. Esta varredura é a metade que faltava: o mesmo
 * fato, três dias antes, quando ainda dá para decidir sem parar de trabalhar.
 *
 * **Uma vez por dia, e não de hora em hora.** O corte precisa da hora exata porque a
 * varredura *é* o vencimento; o aviso não — antecipá-lo ou atrasá-lo em algumas horas não
 * muda nada para quem o lê. Rodar de dia em dia é o que mantém o volume de eventos
 * proporcional ao que eles significam.
 *
 * **Quem garante que sai uma vez só é o `dedupeKey` da mensagem**, e não este arquivo.
 * Enquanto o teste estiver dentro da janela, cada passada publica o evento de novo; o
 * motor reconhece a chave `trial-ending:<tenant>` e devolve a mensagem que já existe.
 * A alternativa — uma coluna `trial_warned_at` — seria um estado a mais para manter
 * sincronizado com uma decisão que já tem dono.
 */

/** Quantos dias antes. Três é o fim de semana inteiro mais um dia útil para decidir. */
export const TRIAL_WARNING_DAYS = 3

const DIA_MS = 24 * 60 * 60 * 1000

export async function runTrialWarningsOnce(now: Date = new Date()): Promise<number> {
  const limite = new Date(now.getTime() + TRIAL_WARNING_DAYS * DIA_MS)

  /**
   * A janela é aberta no começo: o teste que **já venceu** não recebe aviso de véspera.
   * Quem chegou lá é caso do corte, que tem o aviso dele.
   */
  const proximos = await getMaintenancePrisma().tenant.findMany({
    where: {
      status: 'TRIAL',
      deletedAt: null,
      trialEndsAt: { gt: now, lte: limite },
    },
    select: { id: true, trialEndsAt: true },
    orderBy: { trialEndsAt: 'asc' },
    take: 200,
  })

  let avisados = 0
  for (const tenant of proximos) {
    if (!tenant.trialEndsAt) continue
    try {
      await publishEvent('tenant.teste_terminando', {
        tenantId: tenant.id,
        /**
         * Arredonda **para cima**: a quarenta e oito horas e meia do fim, o texto diz
         * "3 dias". Para baixo diria "2" e a pessoa que abrisse a tela veria uma data
         * que não bate com o e-mail que acabou de ler.
         */
        daysLeft: Math.max(1, Math.ceil((tenant.trialEndsAt.getTime() - now.getTime()) / DIA_MS)),
        trialEndsAt: tenant.trialEndsAt.toISOString(),
      })
      avisados += 1
    } catch (error) {
      logger.error({ err: error, tenantId: tenant.id }, 'falha ao avisar do fim do teste')
    }
  }

  if (avisados > 0) logger.info({ avisados }, 'avisos de fim de teste publicados')
  return avisados
}
