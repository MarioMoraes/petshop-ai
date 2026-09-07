import { signServiceHeaders } from '@petshop/service-auth'
import {
  AppError,
  ERROR_CATALOG,
  type AddressResponse,
  type ConsentsResponse,
  type DeletionRequestResponse,
  type ErrorCode,
  type PermissionKey,
  type PortalAddressInput,
  type PortalChannel,
  type TermKind,
  type TutorExport,
  type UpdatePortalAddressInput,
} from '@petshop/shared-types'
import { loadEnv } from '../../env.js'
import { upstreamUnavailable } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

/**
 * A porta para o `tutor-service` — tudo o que o Portal **escreve** na ficha.
 *
 * **Por que HTTP, se o Portal lê o banco direto.** Porque gravar na ficha não é gravar
 * uma linha. O `updateTutor` do tutor-service recalcula a completude do cadastro, derruba
 * os caches que a recepção lê no balcão, publica `tutor.atualizado` e escreve a trilha; o
 * `updateConsents` faz o mesmo com a transição de consentimento. Refazer isso aqui criaria
 * um segundo gravador da mesma ficha, e o dia em que um dos dois mudasse de regra o
 * cadastro passaria a depender de qual tela a pessoa usou.
 *
 * A **leitura** continua sendo banco direto: ler é recorte, e recorte é o que o BFF faz.
 *
 * **A elevação de permissão é a quarta do módulo, e a única que assina escrita.** O papel
 * `TUTOR` não tem `tutor:update`; esta porta assina um contexto que tem. O que a contém:
 *
 * 1. o `tutorId` vem de `requireOwnScope`, nunca do corpo da requisição — o Portal não
 *    tem como nomear ficha alheia, porque a única que ele conhece é a da própria sessão;
 * 2. as rotas chamadas são seis, e estão nomeadas nos métodos abaixo. Nenhuma delas
 *    aceita campo livre: cada método monta o corpo a partir de um tipo fechado, e o que
 *    o tutor não pode mudar não tem por onde chegar aqui;
 * 2b. **cada método assina só a permissão de que precisa.** A exportação do AC-04 pede
 *    `tutor:read` e não `tutor:update`, embora a segunda cobrisse a primeira na matriz:
 *    assinar o mínimo é o que faz esta porta continuar contida quando alguém acrescentar
 *    o sétimo método sem reler este comentário;
 * 3. o telefone e o e-mail só passam **depois** do código do MOD-PORTAL-09 (AC-02), e
 *    quem confere o código é `contact-change.ts`, não esta porta;
 * 4. `purpose` é sempre `MARKETING` e `source` sempre `PORTAL` no consentimento, fixados
 *    aqui e não aceitos do cliente: um pedido forjado com `TRANSACTIONAL` cortaria os
 *    avisos de agendamento do próprio tutor — dano disfarçado de preferência;
 * 5. o `userId` assinado é o do tutor, e é ele que aparece como autor na trilha do outro
 *    lado. Um cadastro alterado por "ninguém" seria indefensável na primeira reclamação.
 *
 * **O IP e o user agent viajam nos headers**, e não é detalhe de log: `tutor_consents` e
 * `data_deletion_requests` guardam os dois como *prova* (§4 do PRD de tutores). Sem
 * repassá-los, a linha registraria o endereço do contêiner do BFF — uma prova que aponta
 * para nós mesmos. O tutor-service sobe com `trustProxy`, então lê o `x-forwarded-for`
 * daqui.
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
   * A sétima rota da porta, e a que mais exige do contrato acima: `source` é fixado em
   * `PORTAL` aqui, como o `purpose` do consentimento, porque ele **é prova** — um aceite
   * que se dissesse do balcão descreveria uma cena que não houve.
   */
  acceptTerm(caller: TutorCaller, tutorId: string, kind: TermKind): Promise<void>
}

const REQUEST_TIMEOUT_MS = 10_000

/** O mínimo. Escrever na ficha do tutor é editar o tutor; nada além disso é assinado. */
const WRITE_PERMISSIONS: PermissionKey[] = ['tutor:update']

/** O mínimo da leitura. A exportação do AC-04 é o único método que usa este conjunto. */
const READ_PERMISSIONS: PermissionKey[] = ['tutor:read']

interface ProblemBody {
  code?: string
  detail?: string
  [key: string]: unknown
}

/**
 * Uma chamada ao tutor-service, com a assinatura e a tradução de erro.
 *
 * O tratamento de falha é o mesmo das outras portas do módulo, e o detalhe que importa
 * está no `conhecido`: **código de fora do catálogo vira 502**. `new AppError` lê o status
 * do catálogo e estouraria dentro do próprio construtor com um código desconhecido —
 * transformando a falha do outro serviço num 500 deste. Acontece de verdade quando os dois
 * sobem em versões diferentes, que é a hora em que o log precisa dizer a verdade.
 */
async function call<T>(
  caller: TutorCaller,
  path: string,
  method: 'GET' | 'PATCH' | 'POST' | 'PUT',
  body: unknown,
  falha: string,
  permissions: PermissionKey[] = WRITE_PERMISSIONS,
): Promise<T> {
  const env = loadEnv()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    const signed = signServiceHeaders(
      {
        clerkUserId: caller.clerkUserId,
        ...(caller.userId ? { userId: caller.userId } : {}),
        tenantId: caller.tenantId,
        permissions: [...permissions],
      },
      env.INTERNAL_SERVICE_SECRET,
    )

    response = await fetch(`${env.TUTOR_SERVICE_URL}${path}`, {
      method,
      headers: {
        ...signed,
        'content-type': 'application/json',
        ...(caller.ipAddress ? { 'x-forwarded-for': caller.ipAddress } : {}),
        ...(caller.userAgent ? { 'user-agent': caller.userAgent } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
  } catch (error) {
    logger.error({ err: error, path }, 'falha ao falar com o tutor-service')
    throw upstreamUnavailable(falha)
  } finally {
    clearTimeout(timeout)
  }

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const problema = payload as ProblemBody | null
    const conhecido = problema?.code !== undefined && problema.code in ERROR_CATALOG

    if (response.status >= 500 || !conhecido) {
      logger.error(
        { status: response.status, path, detail: problema?.detail },
        'tutor-service recusou a escrita do Portal',
      )
      throw upstreamUnavailable(falha)
    }

    const { code, detail } = problema ?? {}
    throw new AppError(code as ErrorCode, typeof detail === 'string' ? detail : falha)
  }

  return payload as T
}

function createHttpPort(): TutorPort {
  return {
    updateMarketingConsent(caller, tutorId, input) {
      return call<ConsentsResponse>(
        caller,
        `/v1/tutors/${tutorId}/consents`,
        'PUT',
        {
          transitions: [
            {
              channel: input.channel,
              granted: input.granted,
              purpose: 'MARKETING',
              source: 'PORTAL',
              // A versão não vai daqui: quem sabe qual termo o estabelecimento tem
              // publicado é o tutor-service (MOD-DOC-06). Mandar a constante do código
              // gravaria `1.0` numa base que já está na `2.0`.
            },
          ],
        },
        'Não foi possível salvar a preferência agora.',
      )
    },

    async acceptTerm(caller, tutorId, kind) {
      await call(
        caller,
        `/v1/tutors/${tutorId}/term-acceptances`,
        'POST',
        { kind, source: 'PORTAL' },
        'Não foi possível registrar o aceite agora.',
      )
    },

    async updateOwnProfile(caller, tutorId, patch) {
      await call(
        caller,
        `/v1/tutors/${tutorId}`,
        'PATCH',
        patch,
        'Não foi possível salvar os seus dados agora.',
      )
    },

    /**
     * O mesmo `PATCH` do perfil, e é de propósito que seja.
     *
     * O telefone e o e-mail passam pela mesma porta que o resto da ficha porque quem
     * cifra, calcula o hash de busca e derruba o cache do contato é o tutor-service — um
     * caminho separado teria de repetir os três, e o dia em que o namespace do hash
     * mudasse, o Portal gravaria uma ficha que a busca do balcão não encontra.
     *
     * O que separa este método do anterior não é o transporte, é **quem pode chamá-lo**:
     * só `contact-change.ts`, depois de conferir o código que provou a posse do contato.
     */
    async applyContactChange(caller, tutorId, patch) {
      await call(
        caller,
        `/v1/tutors/${tutorId}`,
        'PATCH',
        patch,
        'Não foi possível salvar o contato agora.',
      )
    },

    addAddress(caller, tutorId, input) {
      return call<AddressResponse>(
        caller,
        `/v1/tutors/${tutorId}/addresses`,
        'POST',
        input,
        'Não foi possível salvar o endereço agora.',
      )
    },

    updateAddress(caller, tutorId, addressId, patch) {
      return call<AddressResponse>(
        caller,
        `/v1/tutors/${tutorId}/addresses/${addressId}`,
        'PATCH',
        patch,
        'Não foi possível salvar o endereço agora.',
      )
    },

    requestDeletion(caller, tutorId, input) {
      return call<DeletionRequestResponse>(
        caller,
        `/v1/tutors/${tutorId}/deletion-request`,
        'POST',
        input.reason ? { reason: input.reason } : {},
        'Não foi possível registrar o pedido agora.',
      )
    },

    /**
     * AC-04 — o direito de acesso do art. 18, em autoatendimento.
     *
     * Vai pela porta, e não por uma consulta daqui, por uma razão que não é a das outras:
     * a exportação **audita a própria leitura** (`tutor.exported` em `overview.ts`), e é
     * essa linha que prova ao titular, e a quem fiscalizar, que o direito foi exercido e
     * quando. Refazer a consulta no BFF produziria o mesmo JSON sem a prova.
     *
     * O que desce é mais do que `GET /portal/v1/me/data` mostra — as anotações da recepção
     * inclusive. É correto que seja: a tela é recorte de trabalho, a exportação é o direito
     * de acesso, e o PRD de tutores §9 diz explicitamente que o campo livre entra.
     */
    exportOwnData(caller, tutorId) {
      return call<TutorExport>(
        caller,
        `/v1/tutors/${tutorId}/export`,
        'GET',
        undefined,
        'Não foi possível preparar os seus dados agora.',
        READ_PERMISSIONS,
      )
    },
  }
}

let port: TutorPort | null = null

export function getTutorPort(): TutorPort {
  port ??= createHttpPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setTutorPort(next: TutorPort | null): void {
  port = next
}
