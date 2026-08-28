import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do crm-automation-service, validada na subida.
 *
 * A porta é **3009**, e `MESSAGING_SERVICE_URL` é a novidade: este é o primeiro
 * serviço do sistema que fala **HTTP com outro serviço**. Todos os demais se
 * comunicam por banco compartilhado ou por evento.
 *
 * A escolha é do PRD (§5) e o motivo é o corte de responsabilidade: este serviço
 * decide *quem e quando*, o messaging-service sabe *como entregar*. Escrever direto na
 * tabela `messages` daqui furaria esse corte — a janela de silêncio, o dedupe e a
 * checagem de consentimento moram lá, e um segundo escritor teria de reimplementá-los.
 *
 * O salto é seguro porque toda automação crítica é **varredura idempotente**: se o
 * messaging estiver fora, a passada falha e a seguinte, uma hora depois, reenfileira o
 * que faltou — o `dedupeKey` garante que nada saia duas vezes.
 */

export const { loadEnv, resetEnvCache } = defineEnv('crm-automation-service', {
  ...serviceEnvShape,
  CRM_AUTOMATION_SERVICE_PORT: z.coerce.number().int().default(3009),
  MESSAGING_SERVICE_URL: z.string().url().default('http://localhost:3010'),
})

export type Env = ReturnType<typeof loadEnv>
