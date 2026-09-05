import { withTenant, type TenantTransaction } from '@petshop/db'
import {
  maskCNPJ,
  maskCPF,
  maskPhone,
  maskPortalTarget,
  portalChannelOfField,
  type PortalAddress,
  type PortalDeletionRequest,
  type PortalAddressInput,
  type PortalDeletionRequestInput,
  type PortalMeDataResponse,
  type PortalProfile,
  type UpdateOwnTutorInput,
  type UpdatePortalAddressInput,
} from '@petshop/shared-types'
import { notFound } from '../../lib/errors.js'
import { decryptOptional, openCipher, type PortalCipher } from './crypto.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'

/**
 * MOD-PORTAL-09 — a ficha do tutor, lida por ele mesmo.
 *
 * Leitura de banco direto, como toda leitura do Portal desde a fatia 2. O que muda aqui é
 * que a resposta é **um recorte da mesma linha que o balcão vê**, e o recorte é a parte
 * interessante:
 *
 * - `notes` fica de fora. É a anotação que a recepção faz *sobre* o cliente — "prefere a
 *   Ana", "sempre atrasa" —, e devolvê-la ao titular transformaria um caderno de trabalho
 *   em correspondência. O direito de acesso do art. 18 continua atendido pelo AC-04, que
 *   exporta a ficha inteira por um caminho declarado.
 * - CPF e CNPJ descem **mascarados**, como no balcão. O titular os reconhece sem que o
 *   documento inteiro passe a existir dentro do navegador dele, que é onde o Portal roda:
 *   celular de família, tela aberta, sessão que ninguém fechou.
 * - o telefone também sai mascarado, e o e-mail **não**. A diferença não é descuido: o
 *   e-mail é o que o tutor precisa ler por extenso para decidir se está certo, e não abre
 *   porta nenhuma sozinho; o telefone é a chave de identidade do sistema (RN-03 do
 *   MOD-TUTOR) e já aparece por inteiro no aparelho de quem o possui.
 * - latitude e longitude não descem com o endereço: a geocodificação existe para
 *   roteirizar a van, não para o titular conferir a rua.
 */

export async function readOwnData(
  tenantId: string,
  tutorId: string,
): Promise<PortalMeDataResponse> {
  return withTenant(tenantId, async (tx) => {
    const cipher = await openCipher(tx, tenantId)

    const tutor = await tx.tutor.findFirst({
      where: { id: tutorId, anonymizedAt: null, deletedAt: null },
      select: {
        fullName: true,
        socialName: true,
        cpfEncrypted: true,
        cnpjEncrypted: true,
        phoneEncrypted: true,
        emailEncrypted: true,
        birthDate: true,
      },
    })
    if (!tutor) throw notFound()

    const [addresses, pending, deletion] = await Promise.all([
      tx.tutorAddress.findMany({
        where: { tutorId },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      readPendingContact(tx, tutorId, cipher),
      readDeletionRequest(tx, tutorId),
    ])

    const profile: PortalProfile = {
      fullName: tutor.fullName,
      socialName: tutor.socialName,
      // RN-14: o nome social é o nome exibido, e no Portal ele é o nome com que a pessoa
      // é cumprimentada em toda tela.
      displayName: tutor.socialName ?? tutor.fullName,
      cpfMasked: maskOptional(decryptOptional(cipher, tutor.cpfEncrypted), maskCPF),
      cnpjMasked: maskOptional(decryptOptional(cipher, tutor.cnpjEncrypted), maskCNPJ),
      phoneMasked: maskPhone(cipher.decrypt(tutor.phoneEncrypted)),
      email: decryptOptional(cipher, tutor.emailEncrypted),
      birthDate: tutor.birthDate ? tutor.birthDate.toISOString().slice(0, 10) : null,
    }

    return {
      profile,
      addresses: addresses.map((row) => toPortalAddress(row, cipher)),
      pendingContact: pending,
      deletionRequest: deletion,
    }
  })
}

function maskOptional(value: string | null, mask: (raw: string) => string): string | null {
  return value ? mask(value) : null
}

interface AddressRow {
  id: string
  label: string
  zipCode: string
  streetEncrypted: string
  numberEncrypted: string
  complementEncrypted: string | null
  district: string
  city: string
  state: string
  accessNotes: string | null
  isPrimary: boolean
}

function toPortalAddress(row: AddressRow, cipher: PortalCipher): PortalAddress {
  return {
    id: row.id,
    label: row.label,
    zipCode: row.zipCode,
    street: cipher.decrypt(row.streetEncrypted),
    number: cipher.decrypt(row.numberEncrypted),
    complement: decryptOptional(cipher, row.complementEncrypted),
    district: row.district,
    city: row.city,
    state: row.state,
    accessNotes: row.accessNotes,
    isPrimary: row.isPrimary,
  }
}

/**
 * A troca de contato que ainda espera código.
 *
 * Existe porque recarregar a página no meio da verificação é o caso comum, e não a
 * exceção: o tutor sai do navegador para ler a mensagem e volta. Sem este campo ele
 * voltaria para um formulário vazio, com um desafio aberto que ele não pode nem retomar
 * nem cancelar — só esperar expirar.
 *
 * O destino sai **mascarado** mesmo aqui, onde a sessão já é dele: o valor pendente é o
 * que ele acabou de digitar, e a tela não ganha nada exibindo-o por inteiro.
 */
async function readPendingContact(
  tx: TenantTransaction,
  tutorId: string,
  cipher: PortalCipher,
): Promise<PortalMeDataResponse['pendingContact']> {
  const row = await tx.portalContactChange.findFirst({
    where: {
      tutorId,
      consumedAt: null,
      blocked: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, field: true, pendingValueEncrypted: true, expiresAt: true },
  })
  if (!row) return null

  return {
    id: row.id,
    field: row.field,
    maskedTarget: maskPortalTarget(
      cipher.decrypt(row.pendingValueEncrypted),
      portalChannelOfField(row.field),
    ),
    expiresAt: row.expiresAt.toISOString(),
  }
}

/**
 * O pedido de exclusão em análise, ou o último respondido.
 *
 * Um só, e não a lista. A tela do titular responde "o meu pedido andou?"; um histórico de
 * pedidos anteriores só serviria para relembrá-lo de recusas antigas.
 *
 * `status: 'asc'` traz o aberto na frente porque o Postgres ordena `enum` pela ordem de
 * declaração, e o tipo nasceu como `('OPEN', 'DONE', 'REJECTED')`.
 */
async function readDeletionRequest(
  tx: TenantTransaction,
  tutorId: string,
): Promise<PortalDeletionRequest | null> {
  const row = await tx.dataDeletionRequest.findFirst({
    where: { tutorId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      status: true,
      createdAt: true,
      dueAt: true,
      respondedAt: true,
      resolution: true,
    },
  })
  if (!row) return null

  return {
    id: row.id,
    status: row.status,
    requestedAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    resolution: row.resolution,
  }
}

/**
 * AC-05 — o pedido de exclusão, registrado e encaminhado à equipe.
 *
 * Vai pela porta, e não por um `INSERT` daqui, pelo motivo de sempre: a tabela é do
 * tutor-service, que é quem a lista para a equipe e quem escreve a trilha. Dois
 * gravadores da mesma fila é o que a porta do consentimento evitou no MOD-PORTAL-10.
 *
 * Devolve a ficha inteira relida em vez do pedido criado: a tela que dispara isto é a
 * mesma que mostra o estado, e uma resposta parcial a obrigaria a um segundo `GET` para
 * saber o que exibir.
 */
export async function requestOwnDeletion(
  caller: TutorCaller,
  tutorId: string,
  input: PortalDeletionRequestInput,
): Promise<PortalMeDataResponse> {
  await getTutorPort().requestDeletion(caller, tutorId, {
    reason: input.reason,
  })
  return readOwnData(caller.tenantId, tutorId)
}

/**
 * AC-01 — os dados que o tutor muda sozinho.
 *
 * O que ele **não** muda não chega aqui: `UpdateOwnTutorSchema` é `.strict()` e declara
 * dois campos. Nome civil, CPF, telefone e e-mail são recusados pelo contrato, antes do
 * handler — a trava não é uma checagem que a próxima rota de escrita possa esquecer.
 */
export async function updateOwnProfile(
  caller: TutorCaller,
  tutorId: string,
  patch: UpdateOwnTutorInput,
): Promise<PortalMeDataResponse> {
  // Um PATCH vazio não vira chamada: o tutor-service devolveria a ficha sem mudar nada,
  // e teríamos gasto uma requisição para publicar um `tutor.atualizado` de nada.
  if (Object.keys(patch).length > 0) {
    await getTutorPort().updateOwnProfile(caller, tutorId, patch)
  }
  return readOwnData(caller.tenantId, tutorId)
}

/** AC-01 — o endereço novo. As mesmas validações e o mesmo ViaCEP do balcão. */
export async function addOwnAddress(
  caller: TutorCaller,
  tutorId: string,
  input: PortalAddressInput,
): Promise<PortalMeDataResponse> {
  await getTutorPort().addAddress(caller, tutorId, input)
  return readOwnData(caller.tenantId, tutorId)
}

/**
 * AC-01 — corrigir um endereço.
 *
 * O `addressId` é conferido **aqui**, contra os endereços deste tutor, e não confiado ao
 * tutor-service: a porta assina `tutor:update` para o tenant inteiro, e o serviço do outro
 * lado aceitaria qualquer id de endereço do estabelecimento. É a diferença entre o escopo
 * `_own` valer e parecer valer (RN-02 e AC-03 de MOD-PORTAL-02).
 *
 * A resposta é 404, e não 403, para endereço de outra ficha — a regra do RN-03.
 */
export async function updateOwnAddress(
  caller: TutorCaller,
  tutorId: string,
  addressId: string,
  patch: UpdatePortalAddressInput,
): Promise<PortalMeDataResponse> {
  const meu = await withTenant(caller.tenantId, (tx) =>
    tx.tutorAddress.findFirst({ where: { id: addressId, tutorId }, select: { id: true } }),
  )
  if (!meu) throw notFound()

  await getTutorPort().updateAddress(caller, tutorId, addressId, patch)
  return readOwnData(caller.tenantId, tutorId)
}
