'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import {
  BrandingSchema,
  BusinessHoursSchema,
  CreateBreedSchema,
  PublishTermVersionSchema,
  ResolveDeletionRequestSchema,
  UpdateTenantSchema,
  UpdateTenantSettingsSchema,
  type Breed,
  type CepLookup,
  type DeletionRequestResponse,
  type ManagedBreed,
  type TenantResponse,
  type TenantSettings,
  type AuditLogPage,
  type SecurityEventPage,
  type SupportGrantResponse,
  type TermVersionView,
} from '@petshop/shared-types'
import { z } from 'zod'
import { serverApi } from '@/lib/api'

/**
 * Ações da tela de configurações (MOD-IDENT-08, parcial).
 *
 * Rodam no servidor: o token do Clerk e a URL do gateway nunca chegam ao browser.
 * Cada ação devolve um resultado discriminado em vez de lançar — o formulário precisa
 * mostrar o erro no campo certo, não uma tela de erro.
 *
 * A validação é feita aqui **e** no serviço. A daqui existe para o erro aparecer no
 * campo antes da viagem de rede; quem decide é o 422 do backend.
 */

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; message: string; fieldErrors: Record<string, string> }

function toFailure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors }
  }
  // Gateway fora do ar, DNS, timeout: o usuário não tem o que fazer com o detalhe.
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

function fromZod(error: z.ZodError): ActionResult<never> {
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
  )
  return { ok: false, message: error.issues[0]?.message ?? 'Dados inválidos', fieldErrors }
}

/**
 * `/dashboard` mostra o nome do estabelecimento e saúda pelo fuso configurado; as
 * telas de tutores herdam o cabeçalho. Revalidar as três evita o incômodo clássico de
 * salvar e continuar vendo o valor antigo na navegação.
 */
function revalidateAll(): void {
  revalidatePath('/configuracoes')
  revalidatePath('/dashboard')
  revalidatePath('/tutores')
}

// ─── Dados do estabelecimento ────────────────────────────────────────────────

export async function saveIdentityAction(input: unknown): Promise<ActionResult<TenantResponse>> {
  const parsed = UpdateTenantSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const tenant = await serverApi().updateTenant(parsed.data)
    revalidateAll()
    return { ok: true, data: tenant }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Endereço e contato públicos (MOD-SITE-02) ───────────────────────────────

const ContactPatchSchema = UpdateTenantSettingsSchema.pick({
  address: true,
  publicPhone: true,
  publicWhatsapp: true,
})

/**
 * Endereço e telefones que o site, o mapa e o recibo publicam.
 *
 * As três chaves vão sempre juntas, e `address: null` **apaga** o endereço — é como o
 * admin remove um endereço errado depois de já ter publicado. Por isso o formulário
 * envia o objeto inteiro a cada salvamento, e não um campo por vez.
 */
export async function saveContactAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = ContactPatchSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings(parsed.data)
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Preenchimento por CEP, reaproveitando a mesma rota do MOD-TUTOR
 * (`/v1/tutors/cep-lookup`, protegida por `tutor:read`, que o admin tem).
 *
 * Não vale a pena um segundo endpoint no MOD-IDENT: é a mesma consulta, com o
 * mesmo cache de 24h e a mesma porta injetável. `null` quando o CEP não existe ou o
 * ViaCEP está fora — os dois dão no mesmo para quem está preenchendo, que segue no
 * braço.
 */
export async function lookupCepAction(cep: string): Promise<CepLookup | null> {
  const digits = cep.replace(/\D/g, '')
  if (digits.length !== 8) return null
  try {
    return await serverApi().lookupCep(digits)
  } catch {
    return null
  }
}

// ─── Horário de funcionamento ────────────────────────────────────────────────

const HoursPatchSchema = z.object({
  timezone: z.string().min(1),
  businessHours: BusinessHoursSchema,
})

export async function saveHoursAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = HoursPatchSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings(parsed.data)
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Políticas de agenda ─────────────────────────────────────────────────────

const PoliciesPatchSchema = UpdateTenantSettingsSchema.pick({
  cancellationWindowHours: true,
  minBookingNoticeHours: true,
  noShowFeePercent: true,
  allowOverbooking: true,
  onlineBookingEnabled: true,
  onlineBookingRequiresApproval: true,
})

export async function savePoliciesAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = PoliciesPatchSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings(parsed.data)
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Identidade visual ───────────────────────────────────────────────────────

export async function saveBrandingAction(input: unknown): Promise<ActionResult<TenantSettings>> {
  const parsed = BrandingSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const settings = await serverApi().updateSettings({ branding: parsed.data })
    revalidateAll()
    return { ok: true, data: settings }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Catálogo de raças (MOD-PET-03) ──────────────────────────────────────────

/**
 * O catálogo do tenant mora nas configurações porque é decisão do estabelecimento, e
 * não do atendimento: RN-01 proíbe raça em texto livre, então a lista do seletor é
 * uma configuração como o horário de funcionamento.
 *
 * Revalidar `/pets` junto: o formulário de cadastro lê o mesmo catálogo, e uma raça
 * criada aqui precisa aparecer lá sem recarregar a sessão.
 */
function revalidateCatalog(): void {
  revalidatePath('/configuracoes')
  revalidatePath('/pets')
}

export async function listManagedBreedsAction(speciesId: string): Promise<ManagedBreed[]> {
  try {
    return await serverApi().listManagedBreeds(speciesId)
  } catch {
    // A tela mostra a lista vazia com o aviso; travar a aba inteira por uma falha de
    // leitura seria pior que mostrá-la sem conteúdo.
    return []
  }
}

export async function createBreedAction(input: unknown): Promise<ActionResult<Breed>> {
  const parsed = CreateBreedSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const breed = await serverApi().createBreed(parsed.data)
    revalidateCatalog()
    return { ok: true, data: breed }
  } catch (error) {
    return toFailure(error)
  }
}

export async function setBreedVisibilityAction(
  breedId: string,
  hidden: boolean,
): Promise<ActionResult<ManagedBreed>> {
  try {
    const breed = await serverApi().setBreedVisibility(breedId, hidden)
    revalidateCatalog()
    return { ok: true, data: breed }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteBreedAction(breedId: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteBreed(breedId)
    revalidateCatalog()
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Pedidos de exclusão de dados (LGPD art. 18, V) ──────────────────────────

/**
 * A resposta da equipe ao titular (AC-05 de MOD-PORTAL-09).
 *
 * **Não anonimiza nada.** Marcar como atendido registra o desfecho e a frase que o tutor
 * vai ler no Portal; apagar a ficha continua sendo a ação própria, com as travas de débito
 * aberto e agenda futura que ela tem. Ligar as duas faria um clique nesta fila apagar o
 * cadastro de quem deve dinheiro ao petshop e tem nota fiscal em prazo de guarda.
 */
/**
 * Publica uma versão de termo (MOD-DOC-06).
 *
 * Não existe ação de editar, e a ausência é a regra: republicar um número já publicado
 * volta como 409 `ERR_DOC_004`, porque alguém já aceitou aquele texto. O caminho é
 * publicar a versão seguinte.
 */
export async function publishTermVersionAction(
  input: unknown,
): Promise<ActionResult<TermVersionView>> {
  const parsed = PublishTermVersionSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const version = await serverApi().publishTermVersion(parsed.data)
    revalidatePath('/configuracoes')
    return { ok: true, data: version }
  } catch (error) {
    return toFailure(error)
  }
}

export async function resolveDeletionRequestAction(
  requestId: string,
  input: unknown,
): Promise<ActionResult<DeletionRequestResponse>> {
  const parsed = ResolveDeletionRequestSchema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const pedido = await serverApi().resolveDeletionRequest(requestId, parsed.data)
    // O sino da topbar conta esta fila, e ele é resolvido no servidor a cada navegação:
    // sem revalidar, o número continuaria contando o pedido que acabou de ser respondido.
    revalidatePath('/configuracoes')
    revalidatePath('/dashboard')
    return { ok: true, data: pedido }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── MOD-SEC-06 — a aba Segurança ──────────────────────────────────────────

/**
 * Uma página da trilha.
 *
 * **Sem `revalidatePath`.** As duas ações abaixo só leem; revalidar aqui derrubaria o
 * cache da tela inteira toda vez que alguém clicasse em "Carregar mais", e recarregaria
 * as configurações, os termos e a fila de exclusão junto — para trocar de página numa
 * lista.
 */
export async function loadAuditPageAction(input: {
  from?: string
  cursor?: string
}): Promise<ActionResult<AuditLogPage>> {
  try {
    return { ok: true, data: await serverApi().listAuditLogs(input) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function loadSecurityEventsAction(input: {
  from?: string
}): Promise<ActionResult<SecurityEventPage>> {
  try {
    return { ok: true, data: await serverApi().listSecurityEvents(input) }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── MOD-ADMIN-02 — o acesso do suporte ──────────────────────────────────────

/**
 * As três decisões que o estabelecimento toma sobre o acesso da equipe PetShop AI.
 *
 * **Revalidam `/configuracoes` e nada mais.** Nenhuma outra tela mostra o estado do grant,
 * e derrubar o cache do início por causa de uma autorização recarregaria o painel inteiro
 * para atualizar uma linha que só existe aqui.
 *
 * O prazo é conferido no servidor contra `SUPPORT_GRANT_MAX_HOURS`: se o teto do ambiente
 * for menor que o botão oferece, volta 422 e a mensagem aparece no diálogo. O cliente não
 * tenta adivinhar o teto — quem decide política é o ambiente.
 */
export async function approveSupportAccessAction(
  grantId: string,
  hours: number,
): Promise<ActionResult<SupportGrantResponse>> {
  try {
    const grant = await serverApi().approveSupportAccess(grantId, hours)
    revalidatePath('/configuracoes')
    return { ok: true, data: grant }
  } catch (error) {
    return toFailure(error)
  }
}

export async function denySupportAccessAction(grantId: string): Promise<ActionResult<null>> {
  try {
    await serverApi().denySupportAccess(grantId)
    revalidatePath('/configuracoes')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * Encerrar vale no clique.
 *
 * O grant é a única autorização do produto que **não** entra em cache: a checagem lê o
 * banco a cada requisição justamente para que a revogação não tenha janela. A tela pode
 * prometer "agora" porque o backend cumpre "agora".
 */
export async function revokeSupportAccessAction(grantId: string): Promise<ActionResult<null>> {
  try {
    await serverApi().revokeSupportAccess(grantId)
    revalidatePath('/configuracoes')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}
