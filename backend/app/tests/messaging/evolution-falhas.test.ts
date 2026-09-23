import { describe, expect, it } from 'vitest'
import { classifySendFailure } from '../../src/modules/messaging/ports/evolution.js'

/**
 * Sobre quem é a falha de um envio pela Evolution.
 *
 * O defeito que motivou este arquivo (2026-09-23): na VPS nova, com a Evolution ainda sem
 * a chave certa, o 401 voltava como falha permanente e o despacho punha o número do
 * **cliente** na lista de supressão. Nenhuma mensagem saía mais para ele — nem o push
 * que vai junto —, e o painel dizia "devolução definitiva", apontando para o cliente e
 * não para a instalação.
 *
 * A regra do despacho é: permanente e não `CHANNEL_UNAVAILABLE` → suprime. Então o que
 * este arquivo afirma é que só o defeito do destinatário chega lá.
 */
describe('classifySendFailure', () => {
  it.each([401, 403, 404])('HTTP %i é do canal do petshop: volta à fila, não suprime', (status) => {
    const result = classifySendFailure(status, { message: 'Unauthorized' }, 'Unauthorized')

    expect(result.errorCode).toBe('CHANNEL_UNAVAILABLE')
    expect(result.errorDetail).toContain(`HTTP ${status}`)
  })

  it('o número sem WhatsApp é do destinatário, e é o único que suprime', () => {
    const body = {
      status: 400,
      error: 'Bad Request',
      response: { message: [{ jid: '5511900000000@s.whatsapp.net', exists: false, number: '5511900000000' }] },
    }

    const result = classifySendFailure(400, body, 'Bad Request')

    expect(result).toMatchObject({ permanent: true, errorCode: 'NOT_ON_WHATSAPP' })
  })

  it('outro 400 é o nosso corpo: retenta e morre pelo backoff, sem suprimir', () => {
    const result = classifySendFailure(400, { message: 'text is required' }, 'text is required')

    expect(result.permanent).toBe(false)
    expect(result.errorCode).toBe('EVOLUTION_400')
  })

  it('a conta bloqueada pela Meta continua sendo o caso que derruba a instância', () => {
    const result = classifySendFailure(403, { message: 'account is disabled' }, 'account is disabled')

    expect(result).toMatchObject({ permanent: true, errorCode: 'WHATSAPP_BANNED' })
  })

  it('5xx é passageiro', () => {
    expect(classifySendFailure(502, 'Bad Gateway', 'Bad Gateway').permanent).toBe(false)
  })
})
