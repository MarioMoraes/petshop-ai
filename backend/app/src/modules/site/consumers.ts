import { z } from 'zod'
import type { ConsumerSpec } from '../../shared/event-consumer.js'
import { refreshSite } from './revalidate.js'

/**
 * O que o resto do sistema conta ao site (AC-03 de MOD-SITE-11).
 *
 * A página é montada de dados que **outros módulos** editam: o horário e o endereço
 * saem de `/configuracoes`, os serviços e os preços saem do catálogo da agenda. Sem
 * estes dois consumidores, o horário corrigido às 9h só apareceria ao meio-dia, pelo
 * TTL — e o AC-02 do MOD-SITE-06 ("o site reflete a mudança sem ninguém tocar no
 * site") viraria letra morta.
 *
 * **Invalida o host daquele tenant, e só ele.** Revalidar todos os sites porque um
 * petshop mudou o horário desperdiça render de todo mundo.
 *
 * Nota sobre o nome do evento do catálogo: o PRD §8 pede `servico.criado` /
 * `.atualizado` / `.removido` e diz que não existem. Existem, desde o MOD-AGENDA:
 * são um evento só, `agenda.servico.alterado`, com `action` no payload
 * (`modules/schedule-catalog/service.ts`). Um evento com ação basta
 * aqui — a reação é a mesma para os três.
 */

/**
 * **O nome da fila não acompanhou a consolidação, de propósito.**
 *
 * É uma fila durável que já existe no RabbitMQ de cada instalação, com as ligações
 * feitas. Renomeá-la criaria uma segunda fila vazia e deixaria a primeira acumulando
 * mensagem que ninguém mais consome — e o sintoma seria o site parando de refletir o
 * que o Admin muda, sem erro nenhum no log. Vale para o nome do lease dos jobs e para
 * as chaves de cache pela mesma razão: são identidade em infraestrutura, não rótulo.
 */
const QUEUE = 'tenant-site-service.events'

const TenantScopedSchema = z.object({ tenantId: z.uuid() })

/**
 * O slug não vem do evento: `tenant.configuracao.atualizada` não o carrega, e inventar
 * um campo novo em um evento consumido por três serviços para poupar uma consulta
 * barata seria trocar acoplamento por microssegundos. `refreshSite` o resolve.
 */

export async function handleTenantSettingsChanged(payload: unknown): Promise<void> {
  const event = TenantScopedSchema.parse(payload)
  await refreshSite(event.tenantId)
}

export async function handleServiceChanged(payload: unknown): Promise<void> {
  const event = TenantScopedSchema.parse(payload)
  await refreshSite(event.tenantId)
}

// ─── Fiação ──────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
  'tenant.configuracao.atualizada': handleTenantSettingsChanged,
  // O plano decide se a página existe: descer do Pro a tira do ar, subir a devolve.
  'tenant.plano.alterado': handleTenantSettingsChanged,
  // O estado da conta também decide se a página existe (RN-06): teste vencido ou
  // suspensão a tiram do ar, e o pagamento a devolve. Sem estes três, o Next serviria o
  // HTML de antes pelo TTL de revalidação.
  'tenant.suspenso': handleTenantSettingsChanged,
  'tenant.ativado': handleTenantSettingsChanged,
  'tenant.reativado': handleTenantSettingsChanged,
  'agenda.servico.alterado': handleServiceChanged,
}

export const siteConsumer: ConsumerSpec = {
  queue: QUEUE,
  label: 'site',
  handlers: HANDLERS,
  // Cinco por vez: os handlers só invalidam cache e revalidam a página, e a ordem entre
  // eles não muda o resultado — a página relida é sempre a de agora.
  prefetch: 5,
}
