import { decryptPlatform, getMaintenancePrisma } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'

/**
 * A saída de e-mail dos alertas (MOD-ADMIN-06, AC-02 e RN-10).
 *
 * **É a terceira saída de e-mail do processo, e a exceção é o próprio critério de
 * aceite.** O MOD-NOTIF tem fila, retentativa, histórico e painel — e é exatamente por ter
 * fila que não serve aqui: quando a regra que dispara é "o RabbitMQ não responde", mandar
 * o aviso pela fila é usar o componente quebrado para avisar que ele quebrou. O alarme
 * sai por HTTP direto ao provedor, no mesmo desenho do convite de equipe do MOD-IDENT.
 *
 * O destino segue a **segunda** opção da questão em aberto nº 3 do PRD: sem
 * `PLATFORM_ALERT_EMAILS`, os administradores de plataforma ativos. Assim a lista anda
 * junto com a equipe, sem deploy — e a variável continua existindo para o caso em que o
 * alarme precisa ir para um plantão que não é administrador do produto.
 */

export interface AlertMail {
  subject: string
  /** Linhas do corpo, na ordem. Texto puro: alarme não é peça de marca. */
  lines: string[]
}

export interface AlertMailerPort {
  /** Resolve mesmo quando o provedor falha: quem chama decide o que fazer com `false`. */
  sendAlert(mail: AlertMail, to: string[]): Promise<boolean>
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 8_000

function createResendAlertMailer(apiKey: string, from: string): AlertMailerPort {
  return {
    async sendAlert(mail, to) {
      if (to.length === 0) {
        logger.warn({ subject: mail.subject }, 'alerta sem destinatário configurado')
        return false
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from,
            to,
            subject: mail.subject,
            text: mail.lines.join('\n'),
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          logger.error(
            { status: response.status, body: body.slice(0, 500) },
            'Resend recusou o envio do alerta',
          )
          return false
        }
        return true
      } catch (error) {
        logger.error({ err: error }, 'falha ao enviar alerta pelo Resend')
        return false
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/**
 * Sem provedor configurado, o alerta vira log — **em `error`**, e não em `warn`.
 *
 * É a única linha que resta de um alarme que ninguém recebeu, e ela precisa aparecer no
 * mesmo filtro em que a equipe procura problema.
 */
function createLoggingAlertMailer(motivo: string): AlertMailerPort {
  return {
    async sendAlert(mail) {
      logger.error({ subject: mail.subject, lines: mail.lines, motivo }, 'alerta sem envio')
      return false
    },
  }
}

let port: AlertMailerPort | null = null

export function getAlertMailer(): AlertMailerPort {
  if (port) return port
  const env = loadEnv()
  if (!env.RESEND_API_KEY) port = createLoggingAlertMailer('RESEND_API_KEY ausente')
  else if (!env.MAIL_FROM) port = createLoggingAlertMailer('MAIL_FROM ausente')
  else port = createResendAlertMailer(env.RESEND_API_KEY, env.MAIL_FROM)
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setAlertMailerPort(next: AlertMailerPort | null): void {
  port = next
}

/**
 * Para quem vai o alarme.
 *
 * A variável de ambiente vence, e a lista de administradores é o padrão. Decifrar o
 * e-mail de cada um custa uma consulta por avaliação **com alerta** — nunca no caminho
 * comum, em que nada dispara.
 */
export async function alertRecipients(): Promise<string[]> {
  const fixos = loadEnv().PLATFORM_ALERT_EMAILS
  if (fixos) {
    return fixos
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean)
  }

  const admins = await getMaintenancePrisma().platformAdmin.findMany({
    where: { revokedAt: null },
    select: { user: { select: { id: true, emailEncrypted: true } } },
  })

  const destinos: string[] = []
  for (const admin of admins) {
    try {
      destinos.push(decryptPlatform(admin.user.emailEncrypted))
    } catch (error) {
      // Chave rotacionada ou linha de outra instalação: um destinatário ilegível não pode
      // impedir o aviso de chegar aos demais.
      logger.warn({ err: error, userId: admin.user.id }, 'e-mail de administrador ilegível')
    }
  }
  return destinos
}
