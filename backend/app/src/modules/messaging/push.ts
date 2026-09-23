import { withTenant } from '@petshop/db'
import { findTemplateDefinition } from '@petshop/shared-types'
import { logger } from '../../shared/logger.js'
import { openCipher } from './crypto.js'
import { getPushPort } from './ports/push.js'

/**
 * O push que vai junto com a mensagem (etapa 9 do app do tutor).
 *
 * **Não é um canal do motor, e é isso que o mantém dentro dele.** O despacho chama
 * esta função depois de a mensagem passar por conta parada, consentimento, supressão,
 * óbito e vínculo — os mesmos portões de quem vai por WhatsApp —, e antes dos tetos de
 * vazão, que protegem o número do petshop e não têm nada a ver com o aparelho do
 * tutor. Uma mensagem bloqueada não chega aqui; uma represada pelo teto já mandou o
 * aviso, e ele não se repete.
 *
 * **Falha aqui nunca muda a mensagem.** O push é aviso de cortesia: a mensagem é o
 * registro, e o status, as tentativas e o `DEAD` dela contam a história do WhatsApp ou
 * do e-mail. Um FCM fora do ar não pode mandar um lembrete para o backoff.
 *
 * O par (mensagem, aparelho) é único em `push_deliveries`, e é ele que garante que a
 * retentativa do despacho — o WhatsApp caiu, a mensagem voltou à fila — não mande o
 * mesmo aviso de novo.
 */

export interface PushMessage {
  id: string
  tutorId: string | null
  templateKey: string
  originType: string | null
  originId: string | null
  pushTitleEncrypted: string | null
  pushBodyEncrypted: string | null
}

export async function sendPushCompanion(tenantId: string, message: PushMessage): Promise<void> {
  if (!message.pushTitleEncrypted || !message.pushBodyEncrypted || !message.tutorId) return

  const port = getPushPort()
  if (!port.isAvailable()) return

  try {
    const alvo = await withTenant(tenantId, async (tx) => {
      const devices = await tx.pushDevice.findMany({
        where: {
          tutorId: message.tutorId!,
          revokedAt: null,
          // O aparelho que já recebeu este aviso não entra: é a retentativa do despacho.
          deliveries: { none: { messageId: message.id } },
        },
        select: { id: true, tokenEncrypted: true },
      })
      if (devices.length === 0) return null

      const cipher = await openCipher(tx, tenantId)
      const tenant = await tx.tenant.findFirst({ select: { slug: true } })
      return {
        slug: tenant?.slug ?? '',
        title: cipher.decrypt(message.pushTitleEncrypted!),
        body: cipher.decrypt(message.pushBodyEncrypted!),
        devices: devices.map((d) => ({ id: d.id, token: cipher.decrypt(d.tokenEncrypted) })),
      }
    })

    if (alvo) {
      const definition = findTemplateDefinition(message.templateKey)
      /**
       * O que o app lê ao ser tocado. `slug` é a guarda do celular com dois petshops: o
       * aviso de um não abre a tela do outro. `agendamento` leva a Meus Agendamentos, e
       * `conta` a Minha conta.
       */
      const data: Record<string, string> = {
        slug: alvo.slug,
        abre: definition?.push?.abre ?? 'agendamento',
        ...(message.originType === 'APPOINTMENT' && message.originId
          ? { appointmentId: message.originId }
          : {}),
      }

      for (const device of alvo.devices) {
        const result = await port.send({
          token: device.token,
          title: alvo.title,
          body: alvo.body,
          data,
        })

        await withTenant(tenantId, async (tx) => {
          await tx.pushDelivery.createMany({
            data: [
              {
                tenantId,
                messageId: message.id,
                deviceId: device.id,
                status: result.ok ? 'SENT' : result.invalidToken ? 'INVALID_TOKEN' : 'FAILED',
                providerMessageId: result.providerMessageId,
                errorCode: result.errorCode ?? null,
              },
            ],
            // Dois processos despachando a mesma mensagem é impossível pela posse do
            // `SENDING`; isto é só a garantia de que, se acontecer, a segunda gravação
            // não derruba nada.
            skipDuplicates: true,
          })
          if (result.invalidToken) {
            await tx.pushDevice.update({
              where: { id: device.id },
              data: { revokedAt: new Date() },
            })
          }
        })
      }
    }

    // Saiu para quem tinha aparelho, e o texto é dado pessoal: some da linha. Um aparelho
    // registrado depois disto não recebe o aviso de uma mensagem que já saiu — nem deveria.
    await withTenant(tenantId, (tx) =>
      tx.message.update({
        where: { id: message.id },
        data: { pushTitleEncrypted: null, pushBodyEncrypted: null },
      }),
    )
  } catch (error) {
    logger.warn({ err: error, tenantId, messageId: message.id }, 'push: aviso não enviado')
  }
}
