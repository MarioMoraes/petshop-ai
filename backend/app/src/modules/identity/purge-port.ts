import { anonymizeAllTutors } from '../tutors/service.js'
import { purgeTenantPhotos } from '../photos/service.js'
import { purgeTenantConversations } from '../agent/retention.js'
import { removeApiKey } from '../agent/api-key.js'
import { dropWhatsappInstance } from '../messaging/whatsapp.js'
import { removeEmailDomain } from '../messaging/email-domain.js'
import { purgeTenantMessagingContacts } from '../messaging/suppressions.js'
import { disconnectOnlineBilling } from '../ledger/online-billing.js'
import { purgeTenantLeads } from '../site/leads.js'
import { purgeTenantPortalCodes } from '../portal/challenge.js'
import { cancelSubscriptionForTermination } from '../subscription/service.js'

/**
 * O que o encerramento de um estabelecimento (MOD-IDENT-10) pede aos outros módulos.
 *
 * Cada método apaga o dado pessoal **pelo módulo dono**, com a regra dele — o tutor passa
 * pelo mesmo `anonymizeTutor` do botão da ficha, a conversa pelo mesmo `wipe` da retenção
 * do agente. Todos são reexecutáveis: o expurgo que cai no meio retoma no dia seguinte.
 *
 * Fica de fora, de propósito, o que a lei manda guardar por 5 anos: lançamentos,
 * pagamentos, caixa, documentos fiscais e a trilha de auditoria.
 */
export interface TenantPurgePort {
  /** A mensalidade da plataforma, cancelada no Asaas já no encerramento. */
  cancelSubscription(tenantId: string): Promise<boolean>
  /** Integrações que falam com terceiros em nome do petshop: desligadas já no encerramento. */
  disconnectIntegrations(tenantId: string): Promise<void>
  anonymizeTutors(tenantId: string): Promise<number>
  purgePhotos(tenantId: string): Promise<number>
  purgeAgentConversations(tenantId: string): Promise<number>
  /** Leads do site, códigos do Portal, supressões, aparelhos e hash de destinatário. */
  purgeContacts(tenantId: string): Promise<void>
}

const inProcess: TenantPurgePort = {
  cancelSubscription: cancelSubscriptionForTermination,
  async disconnectIntegrations(tenantId) {
    const actor = { tenantId }
    await dropWhatsappInstance(tenantId)
    await removeEmailDomain(actor)
    await removeApiKey(actor)
    await disconnectOnlineBilling(actor)
  },
  anonymizeTutors: anonymizeAllTutors,
  purgePhotos: purgeTenantPhotos,
  purgeAgentConversations: purgeTenantConversations,
  async purgeContacts(tenantId) {
    await purgeTenantLeads(tenantId)
    await purgeTenantPortalCodes(tenantId)
    await purgeTenantMessagingContacts(tenantId)
  },
}

let port: TenantPurgePort = inProcess

export function getTenantPurgePort(): TenantPurgePort {
  return port
}

/** Os testes dublam; `null` volta à implementação em processo. */
export function setTenantPurgePort(next: TenantPurgePort | null): void {
  port = next ?? inProcess
}
