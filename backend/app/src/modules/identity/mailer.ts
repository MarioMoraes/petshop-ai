import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * Saída de e-mail do MOD-IDENT (MOD-IDENT-06).
 *
 * **É a segunda saída de e-mail do processo, e continua sendo de propósito.** O
 * MOD-NOTIF já é módulo daqui e tem fila, retentativa, histórico e painel — mas o
 * convite tem um destinatário que o motor não sabe endereçar: o convidado ainda não é
 * usuário, então não tem `user_id`. A migração é conhecida e está escrita no §9 de
 * `docs/prd/notificacoes_email_12.md`; ela muda o caminho do convite e merece fatia
 * própria, não uma linha na fatia da consolidação.
 *
 * Mesma forma do `ClerkPort`: uma porta com um dublê injetável, para que a suíte
 * inteira rode sem chave de provedor e sem mandar e-mail para ninguém.
 *
 * O provedor é o Resend, chamado pela API HTTP com `fetch` — não pelo SDK. São dois
 * campos num POST; um pacote a mais no `node_modules` (a imagem de
 * backend é uma só) não se paga por isso.
 *
 * **Sem `RESEND_API_KEY` ou sem `MAIL_FROM`, o envio vira log.** É o estado de desenvolvimento e o do
 * primeiro deploy: o convite continua sendo criado e o link continua voltando na
 * resposta da API, que é como o admin o entrega hoje. Falhar a criação do convite
 * porque o e-mail não saiu seria trocar um problema de entrega por um de cadastro.
 */

export interface InvitationMail {
  to: string
  tenantName: string
  roleLabel: string
  inviteUrl: string
  invitedByName: string | null
  expiresAt: Date
}

export interface MailerPort {
  /** Resolve mesmo quando o provedor falha: o chamador decide o que fazer com `false`. */
  sendInvitation(mail: InvitationMail): Promise<boolean>
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 8_000

function createResendMailer(apiKey: string, from: string): MailerPort {
  return {
    async sendInvitation(mail) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [mail.to],
            subject: `${mail.tenantName} convidou você para a equipe`,
            html: renderInvitationHtml(mail),
            text: renderInvitationText(mail),
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          // O corpo do Resend traz `{ name, message }`; o e-mail do convidado não entra
          // no log — é o dado pessoal que este módulo justamente manipula.
          const body = await response.text().catch(() => '')
          logger.error(
            { status: response.status, body: body.slice(0, 500) },
            'Resend recusou o envio do convite',
          )
          return false
        }
        return true
      } catch (error) {
        logger.error({ err: error }, 'falha ao falar com o Resend')
        return false
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/** Sem provedor configurado: registra que havia um convite a enviar e segue. */
function createLoggingMailer(motivo: string): MailerPort {
  return {
    async sendInvitation(mail) {
      logger.warn(
        { tenantName: mail.tenantName, roleLabel: mail.roleLabel, motivo },
        `${motivo} — convite criado sem e-mail; entregue o link pela resposta da API`,
      )
      return false
    },
  }
}

// ─── Conteúdo ────────────────────────────────────────────────────────────────

/**
 * HTML de e-mail é HTML de 2005 de propósito: tabela, estilo em atributo, nada de
 * classe. Outlook e Gmail descartam `<style>` no `<head>`, e um convite que chega
 * quebrado parece golpe — exatamente o que não pode acontecer com um link de acesso.
 */
function renderInvitationHtml(mail: InvitationMail): string {
  const convidou = mail.invitedByName
    ? `${escapeHtml(mail.invitedByName)} convidou você`
    : 'Você foi convidado'

  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f7f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#232427">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e8e4de">
    <tr><td style="padding:32px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#8a8578">Convite de equipe</p>
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:600">${convidou} para trabalhar no ${escapeHtml(mail.tenantName)}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#55534d">
        Seu acesso será de <strong>${escapeHtml(mail.roleLabel)}</strong>. Para entrar, crie sua conta com
        <strong>este mesmo e-mail</strong> e o acesso é liberado na hora.
      </p>
      <p style="margin:0 0 24px">
        <a href="${mail.inviteUrl}" style="display:inline-block;padding:13px 24px;background:#e34a32;color:#ffffff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">Aceitar convite</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#8a8578">
        O convite vale até ${formatDate(mail.expiresAt)}. Depois disso, peça um novo a quem administra o petshop.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8578">
        Se o botão não funcionar, copie este endereço:<br><span style="color:#55534d">${mail.inviteUrl}</span>
      </p>
    </td></tr>
  </table>
</body></html>`
}

function renderInvitationText(mail: InvitationMail): string {
  const convidou = mail.invitedByName
    ? `${mail.invitedByName} convidou você`
    : 'Você foi convidado'
  return [
    `${convidou} para trabalhar no ${mail.tenantName}.`,
    '',
    `Seu acesso será de ${mail.roleLabel}. Crie sua conta com este mesmo e-mail:`,
    mail.inviteUrl,
    '',
    `O convite vale até ${formatDate(mail.expiresAt)}.`,
  ].join('\n')
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    timeZone: 'America/Sao_Paulo',
  }).format(date)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Porta ───────────────────────────────────────────────────────────────────

let port: MailerPort | null = null

export function getMailer(): MailerPort {
  if (port) return port
  const env = loadEnv()
  if (!env.RESEND_API_KEY) {
    port = createLoggingMailer('RESEND_API_KEY ausente')
  } else if (!env.MAIL_FROM) {
    // A chave sozinha não envia nada: o Resend recusa qualquer remetente cujo domínio
    // não esteja verificado na conta, e não há padrão que sirva para todo mundo.
    port = createLoggingMailer('MAIL_FROM ausente (domínio verificado no Resend)')
  } else {
    port = createResendMailer(env.RESEND_API_KEY, env.MAIL_FROM)
  }
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setMailerPort(next: MailerPort | null): void {
  port = next
}
