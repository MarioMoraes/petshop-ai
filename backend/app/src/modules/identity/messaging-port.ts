import { EnqueueMessageSchema } from '@petshop/shared-types'
import { enqueueMessage } from '../messaging/messages.js'

/**
 * O que o MOD-IDENT pede ao motor do MOD-NOTIF: o convite de equipe (MOD-NOTIF-12).
 *
 * Até 2026-11-02 o convite tinha um caminho de e-mail próprio, direto ao Resend — sem
 * fila, sem retentativa e sem linha no painel de entregas. Agora é uma mensagem como
 * outra qualquer: `USER` sem `user_id`, ao endereço que o admin digitou, com origem
 * `INVITATION`, e o despacho confere se o convite ainda vale antes de mandar.
 */
export interface TeamInvitationMessage {
  tenantId: string
  invitationId: string
  actorUserId: string
  to: string
  tenantName: string
  roleLabel: string
  inviteUrl: string
  invitedByName: string | null
  /** Já formatada para leitura, no fuso do estabelecimento. */
  validUntil: string
  /** Muda a cada reenvio, que troca o token: o reenvio é mensagem nova. */
  dedupeKey: string
}

export interface InvitationMessagingPort {
  /** O status da mensagem (`QUEUED`, `SENT`, `BLOCKED`…). */
  sendInvitation(message: TeamInvitationMessage): Promise<string>
}

const inProcess: InvitationMessagingPort = {
  async sendInvitation(message) {
    const input = EnqueueMessageSchema.parse({
      recipientKind: 'USER',
      overrideAddress: message.to,
      channel: 'EMAIL',
      templateKey: 'team_invitation',
      dedupeKey: message.dedupeKey,
      originType: 'INVITATION',
      originId: message.invitationId,
      // Quem convida costuma estar ao lado de quem é convidado, esperando o e-mail.
      urgent: true,
      variables: {
        'petshop.nome': message.tenantName,
        'convite.papel': message.roleLabel,
        'convite.link': message.inviteUrl,
        'convite.validade': message.validUntil,
        'convite.convidou': message.invitedByName ?? 'A equipe',
      },
    })
    const result = await enqueueMessage(
      { tenantId: message.tenantId, actorUserId: message.actorUserId },
      input,
    )
    return result.status
  },
}

let port: InvitationMessagingPort = inProcess

export function getInvitationMessagingPort(): InvitationMessagingPort {
  return port
}

/** Os testes dublam; `null` volta à implementação em processo. */
export function setInvitationMessagingPort(next: InvitationMessagingPort | null): void {
  port = next ?? inProcess
}
