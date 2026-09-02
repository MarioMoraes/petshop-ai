import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do messaging-service, validada na subida.
 *
 * A porta é **3010**, seguindo o bloco reservado no plano de serviços (CRM 3009,
 * messaging 3010). O gateway resolve por `MESSAGING_SERVICE_URL`; nada depende do
 * número.
 *
 * `RESEND_API_KEY` e `MAIL_FROM` são opcionais de propósito, como já são no
 * identity-service: sem elas o adaptador de e-mail vira log e a mensagem é marcada
 * como enviada com `provider = 'log'`. É o estado de desenvolvimento e o do primeiro
 * deploy — travar a fila porque falta uma chave transformaria um problema de entrega
 * num problema de fila cheia.
 */

export const { loadEnv, resetEnvCache } = defineEnv('messaging-service', {
  ...serviceEnvShape,
  MESSAGING_SERVICE_PORT: z.coerce.number().int().default(3010),

  RESEND_API_KEY: z.string().min(1).optional(),
  /** Remetente com domínio verificado no Resend. Sem ele o provedor recusa tudo. */
  MAIL_FROM: z.string().min(1).optional(),

  /**
   * Quantas mensagens o worker tira da fila por passada. Vinte é o teto por minuto
   * padrão (RN-05) — puxar mais do que se pode enviar só encheria memória.
   */
  DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),

  /**
   * Evolution API — o canal WhatsApp (MOD-CRM-01).
   *
   * As três são opcionais pela mesma razão que `RESEND_API_KEY`: sem elas o canal fica
   * **indisponível** e a cascata `AUTO` cai para o e-mail, que é exatamente o
   * comportamento de antes desta fatia. É o que permite rodar a suíte inteira e o app
   * de desenvolvimento sem um container de WhatsApp no ar.
   */
  EVOLUTION_API_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().min(1).optional(),
  /**
   * Para onde a Evolution devolve o pareamento e as quedas de conexão. Precisa ser um
   * endereço que **ela** alcance: em desenvolvimento ela é container e o serviço roda
   * no host (`host.docker.internal`); em produção os dois são containers na mesma rede.
   */
  EVOLUTION_WEBHOOK_URL: z.string().url().optional(),
})

export type Env = ReturnType<typeof loadEnv>
