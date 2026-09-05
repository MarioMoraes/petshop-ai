import { withTenant, type TenantTransaction } from '@petshop/db'
import type {
  PortalChannel,
  PortalChannelPreference,
  PortalPreferencesResponse,
  UpdatePortalPreferenceInput,
} from '@petshop/shared-types'
import { notFound } from '../../lib/errors.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'

/**
 * MOD-PORTAL-10 — o que eu quero receber.
 *
 * O corte do módulo em uma frase: **ler é banco, escrever é a porta do tutor-service**.
 * O estado atual é derivado de `tutor_consents`, que é append-only por gatilho; a
 * transição vai por HTTP porque gravar consentimento arrasta cache, evento e trilha —
 * ver a justificativa inteira em `tutor-port.ts`.
 *
 * **Só marketing.** `TRANSACTIONAL` e `OPERATIONAL` — confirmação de agendamento, aviso
 * do motorista a caminho — rodam por execução de contrato (RN-01 do MOD-CRM) e não
 * aparecem como interruptor. Não é omissão: mostrar um botão que recusa o clique é pior
 * que não mostrar botão, e desligar o aviso da van é dano ao próprio tutor.
 */

/** Os dois canais que o tutor decide. `SMS`, `TERMS` e `IMAGE_USE` não são dele. */
const PORTAL_CONSENT_CHANNELS = ['WHATSAPP', 'EMAIL'] as const satisfies readonly PortalChannel[]

export async function readOwnPreferences(
  tenantId: string,
  tutorId: string,
): Promise<PortalPreferencesResponse> {
  return withTenant(tenantId, (tx) => loadPreferences(tx, tutorId))
}

async function loadPreferences(
  tx: TenantTransaction,
  tutorId: string,
): Promise<PortalPreferencesResponse> {
  const tutor = await tx.tutor.findFirst({
    where: { id: tutorId, deletedAt: null },
    // Só a presença do contato, nunca o valor: decidir se o interruptor existe não
    // exige abrir a DEK do tenant, e o que não se decifra não vaza.
    select: { id: true, phoneEncrypted: true, emailEncrypted: true },
  })
  if (!tutor) throw notFound()

  const rows = await tx.tutorConsent.findMany({
    where: { tutorId, channel: { in: [...PORTAL_CONSENT_CHANNELS] } },
    orderBy: { createdAt: 'desc' },
    select: { channel: true, granted: true, purpose: true, createdAt: true },
  })

  /**
   * A **última** transição de cada canal é o estado; as anteriores são a história.
   *
   * A mesma derivação de `loadConsents` no messaging-service e de `currentConsentState`
   * no tutor-service — e é de propósito que as três sejam iguais: o dia em que a regra
   * mudar, muda nas três, e um estado que divergisse do motor de envio faria a tela
   * dizer "desligado" para quem continua recebendo.
   */
  const ultima = new Map<string, (typeof rows)[number]>()
  for (const row of rows) if (!ultima.has(row.channel)) ultima.set(row.channel, row)

  const marketing: PortalChannelPreference[] = PORTAL_CONSENT_CHANNELS.map((channel) => {
    const row = ultima.get(channel)
    return {
      channel,
      /**
       * Sem linha, **desligado**. LGPD art. 8º: silêncio não é consentimento, e um
       * cadastro feito no balcão sem ninguém perguntar nada não autoriza promoção.
       * `BOTH` e `MARKETING` liberam; `TRANSACTIONAL` sozinho, não.
       */
      granted: row ? row.granted && (row.purpose === 'MARKETING' || row.purpose === 'BOTH') : false,
      since: row?.createdAt.toISOString() ?? null,
    }
  })

  const availableChannels: PortalChannel[] = []
  if (tutor.phoneEncrypted) availableChannels.push('WHATSAPP')
  if (tutor.emailEncrypted) availableChannels.push('EMAIL')

  return { marketing, availableChannels }
}

/**
 * AC-03 e AC-04 — o clique vira uma linha nova, e a resposta é o estado relido.
 *
 * Relido do banco, e não montado a partir do que a porta devolveu: `ConsentsResponse`
 * do tutor-service traz o histórico inteiro e os cinco canais, incluindo termos e uso
 * de imagem, que não são assunto desta tela. Reaproveitá-lo faria a resposta do Portal
 * crescer com dado que ele decidiu não mostrar.
 */
export async function updateOwnPreference(
  caller: TutorCaller,
  tutorId: string,
  input: UpdatePortalPreferenceInput,
): Promise<PortalPreferencesResponse> {
  await getTutorPort().updateMarketingConsent(caller, tutorId, input)
  return readOwnPreferences(caller.tenantId, tutorId)
}
