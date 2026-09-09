import {
  AcceptTermSchema,
  AddressInputSchema,
  CreateDeletionRequestSchema,
  UpdateAddressSchema,
  UpdateConsentsSchema,
  UpdateTutorSchema,
  type AddressResponse,
  type ConsentsResponse,
  type DeletionRequestResponse,
  type PortalAddressInput,
  type PortalChannel,
  type TermKind,
  type TutorExport,
  type UpdatePortalAddressInput,
} from '@petshop/shared-types'
import { addAddress, updateAddress } from '../addresses/service.js'
import { updateConsents } from '../consents/service.js'
import { acceptTerm } from '../terms/acceptance.js'
import { exportTutor } from '../tutors/overview.js'
import { requestDeletion } from '../tutors/privacy.js'
import { updateTutor, type ActorContext } from '../tutors/service.js'

/**
 * A porta para o MOD-TUTOR — tudo o que o Portal **escreve** na ficha.
 *
 * **Por que uma porta, se agora é chamada de função.** Porque gravar na ficha não é gravar
 * uma linha. O `updateTutor` recalcula a completude do cadastro, derruba os caches que a
 * recepção lê no balcão, publica `tutor.atualizado` e escreve a trilha; o `updateConsents`
 * faz o mesmo com a transição de consentimento. Refazer isso aqui criaria um segundo
 * gravador da mesma ficha, e o dia em que um dos dois mudasse de regra o cadastro passaria
 * a depender de qual tela a pessoa usou.
 *
 * A **leitura** continua sendo banco direto: ler é recorte, e recorte é o que este módulo
 * faz.
 *
 * **A elevação de permissão continua real, e continua contida.** Enquanto isto era salto
 * HTTP, ela acontecia assinando um contexto com `tutor:update`, que o papel `TUTOR` não
 * tem. Chamando direto, ela virou "chamar a função de serviço sem passar pelo
 * `requirePermission` da rota" — mesma semântica, e o mesmo cerco:
 *
 * 1. o `tutorId` vem de `requireOwnScope`, nunca do corpo da requisição — o Portal não tem
 *    como nomear ficha alheia, porque a única que ele conhece é a da própria sessão;
 * 2. os métodos são sete, e estão nomeados abaixo. Nenhum aceita campo livre: cada um monta
 *    a entrada a partir de um tipo fechado, e o que o tutor não pode mudar não tem por onde
 *    chegar aqui;
 * 3. o telefone e o e-mail só passam **depois** do código do MOD-PORTAL-09 (AC-02), e quem
 *    confere o código é `contact-change.ts`, não esta porta;
 * 4. `purpose` é sempre `MARKETING` e `source` sempre `PORTAL` no consentimento, fixados
 *    aqui e não aceitos do cliente: um pedido forjado com `TRANSACTIONAL` cortaria os avisos
 *    de agendamento do próprio tutor — dano disfarçado de preferência;
 * 5. o ator carrega o `userId` do tutor, e é ele que aparece como autor na trilha. Um
 *    cadastro alterado por "ninguém" seria indefensável na primeira reclamação.
 *
 * **Todo método passa pelo mesmo schema Zod que a rota usava.** Não é cerimônia: os schemas
 * preenchem defaults — `source` do aceite, `purpose` da transição — que a chamada direta
 * pularia. É a diferença que a serialização do salto HTTP escondia.
 *
 * **O IP e o user agent viajam no ator, e não é detalhe de log:** `tutor_consents` e
 * `data_deletion_requests` guardam os dois como *prova* (§4 do PRD de tutores). Enquanto era
 * HTTP eles iam em `x-forwarded-for` e no `user-agent`; perdê-los na conversão gravaria o
 * endereço do próprio processo — uma prova que aponta para nós mesmos.
 */

export interface TutorCaller {
  tenantId: string
  clerkUserId: string
  userId?: string | undefined
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

/** O que o tutor muda sozinho na própria ficha. Ver `UpdateOwnTutorSchema`. */
export interface OwnProfilePatch {
  socialName?: string | null
  birthDate?: string | null
}

/** O contato novo, já provado por código. Um por vez, como o formulário. */
export type ContactPatch = { phone: string } | { email: string }

export interface TutorPort {
  updateMarketingConsent(
    caller: TutorCaller,
    tutorId: string,
    input: { channel: PortalChannel; granted: boolean },
  ): Promise<ConsentsResponse>
  updateOwnProfile(caller: TutorCaller, tutorId: string, patch: OwnProfilePatch): Promise<void>
  applyContactChange(caller: TutorCaller, tutorId: string, patch: ContactPatch): Promise<void>
  addAddress(
    caller: TutorCaller,
    tutorId: string,
    input: PortalAddressInput,
  ): Promise<AddressResponse>
  updateAddress(
    caller: TutorCaller,
    tutorId: string,
    addressId: string,
    patch: UpdatePortalAddressInput,
  ): Promise<AddressResponse>
  requestDeletion(
    caller: TutorCaller,
    tutorId: string,
    input: { reason?: string | undefined },
  ): Promise<DeletionRequestResponse>
  exportOwnData(caller: TutorCaller, tutorId: string): Promise<TutorExport>
  /**
   * O aceite de um termo pelo Portal (AC-02 de MOD-DOC-07).
   *
   * A sétima operação, e a que mais exige do contrato acima: `source` é fixado em `PORTAL`
   * aqui, como o `purpose` do consentimento, porque ele **é prova** — um aceite que se
   * dissesse do balcão descreveria uma cena que não houve.
   */
  acceptTerm(caller: TutorCaller, tutorId: string, kind: TermKind): Promise<void>
}

/** O ator que o MOD-TUTOR recebe, montado do chamador do Portal. */
function actorOf(caller: TutorCaller): ActorContext {
  return {
    tenantId: caller.tenantId,
    actorUserId: caller.userId,
    ipAddress: caller.ipAddress,
    userAgent: caller.userAgent,
  }
}

function createInProcessPort(): TutorPort {
  return {
    async updateMarketingConsent(caller, tutorId, input) {
      const parsed = UpdateConsentsSchema.parse({
        transitions: [
          {
            channel: input.channel,
            granted: input.granted,
            purpose: 'MARKETING',
            source: 'PORTAL',
            // A versão não vai daqui: quem sabe qual termo o estabelecimento tem publicado
            // é o MOD-DOC-06. Mandar a constante do código gravaria `1.0` numa base que já
            // está na `2.0`.
          },
        ],
      })
      return updateConsents(actorOf(caller), tutorId, parsed)
    },

    async acceptTerm(caller, tutorId, kind) {
      const input = AcceptTermSchema.parse({ kind, source: 'PORTAL' })
      await acceptTerm(actorOf(caller), tutorId, input, input.source)
    },

    async updateOwnProfile(caller, tutorId, patch) {
      await updateTutor(actorOf(caller), tutorId, UpdateTutorSchema.parse(patch))
    },

    /**
     * A mesma função do perfil, e é de propósito que seja.
     *
     * O telefone e o e-mail passam pela mesma porta que o resto da ficha porque quem cifra,
     * calcula o hash de busca e derruba o cache do contato é o MOD-TUTOR — um caminho
     * separado teria de repetir os três, e o dia em que o namespace do hash mudasse, o
     * Portal gravaria uma ficha que a busca do balcão não encontra.
     *
     * O que separa este método do anterior não é o transporte, é **quem pode chamá-lo**: só
     * `contact-change.ts`, depois de conferir o código que provou a posse do contato.
     */
    async applyContactChange(caller, tutorId, patch) {
      await updateTutor(actorOf(caller), tutorId, UpdateTutorSchema.parse(patch))
    },

    addAddress(caller, tutorId, input) {
      return addAddress(actorOf(caller), tutorId, AddressInputSchema.parse(input))
    },

    updateAddress(caller, tutorId, addressId, patch) {
      return updateAddress(
        actorOf(caller),
        tutorId,
        addressId,
        UpdateAddressSchema.parse(patch),
      )
    },

    requestDeletion(caller, tutorId, input) {
      const parsed = CreateDeletionRequestSchema.parse(input.reason ? { reason: input.reason } : {})
      return requestDeletion(actorOf(caller), tutorId, parsed)
    },

    /**
     * AC-04 — o direito de acesso do art. 18, em autoatendimento.
     *
     * Vai pela porta, e não por uma consulta daqui, por uma razão que não é a das outras: a
     * exportação **audita a própria leitura** (`tutor.exported` em `tutors/overview.ts`), e
     * é essa linha que prova ao titular, e a quem fiscalizar, que o direito foi exercido e
     * quando. Refazer a consulta aqui produziria o mesmo JSON sem a prova.
     *
     * O que desce é mais do que `GET /portal/v1/me/data` mostra — as anotações da recepção
     * inclusive. É correto que seja: a tela é recorte de trabalho, a exportação é o direito
     * de acesso, e o PRD de tutores §9 diz explicitamente que o campo livre entra.
     */
    exportOwnData(caller, tutorId) {
      return exportTutor(actorOf(caller), tutorId)
    },
  }
}

let port: TutorPort | null = null

export function getTutorPort(): TutorPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTutorPort(next: TutorPort | null): void {
  port = next
}
