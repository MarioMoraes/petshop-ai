'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  AgentSettings,
  AsaasEnvironment,
  BillingSettings,
  OnlineBilling,
  EmailDomainResponse,
  MessagingSettingsResponse,
  WhatsappConnection,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * As ações de Integrações.
 *
 * Nenhuma rota é nova: cada seção grava pelo mesmo endpoint de antes — o remetente pelas
 * configurações de mensagem, a chave PIX pelas do financeiro, o WhatsApp pela conexão do
 * MOD-CRM-01. O que mudou foi o lugar da tela, e o corte de permissão continua sendo o do
 * backend: `crm:configure`, `finance:configure` e `crm:connect_channel`.
 *
 * O `revalidatePath` alcança também a tela de onde cada bloco saiu, porque ela continua
 * mostrando o estado — o CRM diz por onde as mensagens estão saindo.
 */

export interface IntegrationFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
}

export type ActionResult<T> = { ok: true; data: T } | IntegrationFailure

const PAGINA = '/configuracoes/integracoes'

function toFailure(error: unknown): IntegrationFailure {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

// ─── E-mail ──────────────────────────────────────────────────────────────────

export async function updateEmailSenderAction(input: {
  senderName?: string | null
  replyToEmail?: string | null
}): Promise<ActionResult<MessagingSettingsResponse>> {
  try {
    const saved = await serverApi().updateMessagingSettings(input)
    revalidatePath(PAGINA)
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * O domínio próprio: `tenant:configure`. Cadastrar registra no Resend da plataforma e
 * devolve os registros de DNS que a tela mostra.
 */
export async function setEmailDomainAction(input: {
  domain: string
  localPart?: string
}): Promise<ActionResult<EmailDomainResponse>> {
  try {
    const saved = await serverApi().setEmailDomain(input)
    revalidatePath(PAGINA)
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

export async function verifyEmailDomainAction(): Promise<ActionResult<EmailDomainResponse>> {
  try {
    const saved = await serverApi().verifyEmailDomain()
    revalidatePath(PAGINA)
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

export async function removeEmailDomainAction(): Promise<ActionResult<EmailDomainResponse>> {
  try {
    const saved = await serverApi().removeEmailDomain()
    revalidatePath(PAGINA)
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Cobrança ────────────────────────────────────────────────────────────────

export async function updatePixKeyAction(
  pixKey: string | null,
): Promise<ActionResult<BillingSettings>> {
  try {
    const saved = await serverApi().updateBillingSettings({ pixKey })
    revalidatePath(PAGINA)
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * A conta do Asaas do petshop. `tenant:configure`: o backend confere a chave, cadastra a
 * baixa automática na conta dele e só então grava.
 */
export async function connectOnlineBillingAction(input: {
  apiKey: string
  environment: AsaasEnvironment
}): Promise<ActionResult<OnlineBilling>> {
  try {
    const { connection } = await serverApi().connectOnlineBilling(input)
    revalidatePath(PAGINA)
    return { ok: true, data: connection }
  } catch (error) {
    return toFailure(error)
  }
}

export async function disconnectOnlineBillingAction(): Promise<ActionResult<OnlineBilling>> {
  try {
    const { connection } = await serverApi().disconnectOnlineBilling()
    revalidatePath(PAGINA)
    return { ok: true, data: connection }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Assistente de IA ────────────────────────────────────────────────────────

/**
 * A chave da Anthropic. `tenant:configure` no backend, que a confere na Anthropic antes
 * de gravar — a recusa volta aqui como erro de campo.
 */
export async function saveAgentApiKeyAction(apiKey: string): Promise<ActionResult<AgentSettings>> {
  try {
    const saved = await serverApi().setAgentApiKey(apiKey)
    revalidatePath(PAGINA)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

export async function removeAgentApiKeyAction(): Promise<ActionResult<AgentSettings>> {
  try {
    const saved = await serverApi().removeAgentApiKey()
    revalidatePath(PAGINA)
    revalidatePath('/crm/atendimentos')
    return { ok: true, data: saved }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Conexão do WhatsApp (MOD-CRM-01) ────────────────────────────────────────

/**
 * As quatro exigem `crm:connect_channel`, menos a leitura — o corte do AC-06.
 *
 * **Nenhuma delas faz `revalidatePath`.** O cartão vive de estado de cliente enquanto o
 * QR está na tela: um `router.refresh()` a cada resposta do polling reconstruiria a
 * página inteira de três em três segundos, e o QR — que não é persistido — sumiria na
 * primeira volta. Quem recarrega a página é o cartão, uma vez, quando o pareamento
 * conclui.
 */

export async function connectWhatsappAction(): Promise<ActionResult<WhatsappConnection>> {
  try {
    return { ok: true, data: await serverApi().connectWhatsapp() }
  } catch (error) {
    return toFailure(error)
  }
}

export async function refreshWhatsappQrCodeAction(): Promise<ActionResult<WhatsappConnection>> {
  try {
    return { ok: true, data: await serverApi().refreshWhatsappQrCode() }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Recuperação (destrutiva): apaga a instância no provedor e cria outra do zero.
 *
 * Existe porque conectar e pedir QR novo reusam a mesma identidade, e há um estado em
 * que o WhatsApp recusa justamente ela — daí nenhum QR resolver.
 */
export async function recreateWhatsappAction(): Promise<ActionResult<WhatsappConnection>> {
  try {
    return { ok: true, data: await serverApi().recreateWhatsapp() }
  } catch (error) {
    return toFailure(error)
  }
}

export async function getWhatsappConnectionAction(): Promise<ActionResult<WhatsappConnection>> {
  try {
    return { ok: true, data: await serverApi().getWhatsappConnection() }
  } catch (error) {
    return toFailure(error)
  }
}

export async function disconnectWhatsappAction(): Promise<ActionResult<WhatsappConnection>> {
  try {
    const result = await serverApi().disconnectWhatsapp()
    // Esta sim revalida: desconectar muda o canal de tudo o que o CRM mostra.
    revalidatePath(PAGINA)
    revalidatePath('/crm/configuracoes')
    return { ok: true, data: result }
  } catch (error) {
    return toFailure(error)
  }
}
