import sharp from 'sharp'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  asAdmin,
  asRole,
  callApi,
  catalogIds,
  clearStorage,
  closeHarness,
  givenTenant,
  givenTutor,
  installFakeStorage,
  jpegWithExif,
  multipartBody,
  ownerPrisma,
  resetDatabase,
  type Caller,
  type CatalogFixture,
  type FakeStorage,
  type TenantFixture,
} from './fixtures.js'

/**
 * MOD-PET-04 — álbum de fotos, pelos cinco critérios de aceite do PRD pets_03 §3.
 *
 * O storage é dublado, mas tudo antes dele é real: o multipart é montado byte a byte,
 * a imagem é uma JPEG de verdade com EXIF e GPS, e o que chega ao "bucket" é o que o
 * `sharp` produziu. É por isso que o teste do RN-12 consegue provar que o metadado
 * sumiu — ele lê o arquivo gravado, não uma promessa.
 */

let tenant: TenantFixture
let catalog: CatalogFixture
let tutorId: string
let storage: FakeStorage

beforeEach(async () => {
  await resetDatabase()
  storage = installFakeStorage()
  tenant = await givenTenant()
  catalog = await catalogIds()
  tutorId = await givenTutor(tenant, 'Maria Silva')
})

afterAll(async () => {
  clearStorage()
  await closeHarness()
})

async function givenPet(): Promise<string> {
  const response = await callApi({
    ...asAdmin(tenant),
    method: 'POST',
    url: '/v1/pets',
    payload: {
      name: 'Thor',
      speciesId: catalog.speciesDogId,
      sizeId: catalog.sizeLargeId,
      birthDate: '2021-03-10',
      tutors: [{ tutorId, role: 'PRIMARY' }],
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json().id as string
}

async function upload(
  petId: string,
  files: { filename: string; contentType: string; content: Buffer }[],
  fields: Record<string, string> = {},
  caller?: Caller,
) {
  const as = caller ?? asAdmin(tenant)
  const { payload, headers } = multipartBody(files, fields)
  return callApi({ ...as, method: 'POST', url: `/v1/pets/${petId}/photos`, payload, headers })
}

describe('MOD-PET-04 — álbum de fotos', () => {
  it('AC-01: sobe três fotos, gera as variantes e devolve URLs assinadas', async () => {
    const petId = await givenPet()
    const photo = await jpegWithExif()

    const response = await upload(petId, [
      { filename: 'thor-1.jpg', contentType: 'image/jpeg', content: photo },
      { filename: 'thor-2.jpg', contentType: 'image/jpeg', content: photo },
      { filename: 'thor-3.jpg', contentType: 'image/jpeg', content: photo },
    ])

    expect(response.statusCode).toBe(201)
    const photos = response.json() as { id: string; urls: Record<string, string>; isCover: boolean }[]
    expect(photos).toHaveLength(3)

    for (const item of photos) {
      expect(item.urls.thumb).toContain('assinada=1')
      expect(item.urls.medium).toBeTruthy()
      expect(item.urls.full).toBeTruthy()
    }

    // Três variantes por foto, sob o caminho por tenant e por pet (§4).
    expect(storage.objects.size).toBe(9)
    for (const key of storage.objects.keys()) {
      expect(key).toMatch(
        new RegExp(`^tenants/${tenant.tenantId}/pets/${petId}/[0-9a-f-]+/(thumb|medium|full)\\.webp$`),
      )
    }

    const audit = await ownerPrisma.auditLog.findFirst({
      where: { entityId: petId, action: 'pet.photo_uploaded' },
    })
    expect(audit).not.toBeNull()
  })

  it('AC-01/RN-12: o EXIF com GPS não sobrevive ao processamento', async () => {
    const petId = await givenPet()
    const original = await jpegWithExif()
    expect((await sharp(original).metadata()).exif).toBeTruthy()

    await upload(petId, [{ filename: 'gps.jpg', contentType: 'image/jpeg', content: original }])

    for (const stored of storage.objects.values()) {
      const metadata = await sharp(stored).metadata()
      expect(metadata.format).toBe('webp')
      expect(metadata.exif).toBeUndefined()
    }
  })

  it('AC-01: a primeira foto vira capa e aparece na listagem de pets', async () => {
    const petId = await givenPet()
    const uploaded = await upload(petId, [
      { filename: 'capa.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])
    expect(uploaded.json()[0].isCover).toBe(true)

    const detail = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}` })
    expect(detail.json().coverPhotoUrl).toContain('assinada=1')

    // RN-16: é a capa que desambigua cinco "Mel" na busca do balcão.
    const list = await callApi({ ...asAdmin(tenant), method: 'GET', url: '/v1/pets' })
    expect(list.json().data[0].coverPhotoUrl).toContain('assinada=1')
  })

  it('AC-02: PDF renomeado para .jpg é recusado pelo conteúdo, não pela extensão', async () => {
    const petId = await givenPet()
    const fakePdf = Buffer.from('%PDF-1.7\n%âãÏÓ\nfingindo ser foto', 'latin1')

    const response = await upload(petId, [
      { filename: 'thor.jpg', contentType: 'image/jpeg', content: fakePdf },
    ])

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PET_007')
    expect(storage.objects.size).toBe(0)
    expect(await ownerPrisma.petPhoto.count()).toBe(0)
  })

  it('AC-02: arquivo acima de 10 MB é recusado', async () => {
    const petId = await givenPet()
    // JPEG válido no começo, mas grande demais: o limite vale mesmo com magic byte ok.
    const huge = Buffer.concat([await jpegWithExif(), Buffer.alloc(11 * 1024 * 1024, 0x41)])

    const response = await upload(petId, [
      { filename: 'enorme.jpg', contentType: 'image/jpeg', content: huge },
    ])

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('ERR_PET_007')
    expect(await ownerPrisma.petPhoto.count()).toBe(0)
  })

  it('AC-03: cota do plano atingida devolve 402 com o caminho de upgrade', async () => {
    const petId = await givenPet()
    await ownerPrisma.tenant.update({ where: { id: tenant.tenantId }, data: { plan: 'STARTER' } })

    // Preenche a cota do STARTER (500) direto no banco: o que está sob teste é a
    // recusa, não a capacidade de subir quinhentas imagens.
    await ownerPrisma.petPhoto.createMany({
      data: Array.from({ length: 500 }, () => ({
        tenantId: tenant.tenantId,
        petId,
        variants: { thumb: 'a', medium: 'b', full: 'c' },
        sizeBytes: 1024,
        mimeType: 'image/webp',
      })),
    })

    const response = await upload(petId, [
      { filename: 'a-mais.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])

    expect(response.statusCode).toBe(402)
    expect(response.json().code).toBe('ERR_PET_008')
    expect(response.json().quota).toMatchObject({ used: 500, limit: 500 })
    expect(response.json().upgradePath).toBe('/configuracoes')
    // Recusou antes de processar: nada foi para o bucket.
    expect(storage.objects.size).toBe(0)
  })

  it('AC-04: falha do storage devolve 502 e não deixa registro órfão', async () => {
    const petId = await givenPet()
    storage.failNext('put')

    const response = await upload(petId, [
      { filename: 'thor.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])

    expect(response.statusCode).toBe(502)
    expect(response.json().code).toBe('ERR_PET_009')
    expect(await ownerPrisma.petPhoto.count()).toBe(0)
    expect(
      await ownerPrisma.pet.findUniqueOrThrow({ where: { id: petId } }).then((pet) => pet.coverPhotoId),
    ).toBeNull()
  })

  it('AC-04: o que já subiu é removido quando o arquivo seguinte falha', async () => {
    const petId = await givenPet()
    const photo = await jpegWithExif()

    // Segunda foto corrompida: a primeira já está no bucket quando o erro acontece.
    const response = await upload(petId, [
      { filename: 'boa.jpg', contentType: 'image/jpeg', content: photo },
      { filename: 'ruim.jpg', contentType: 'image/jpeg', content: Buffer.from('%PDF-1.7 nao sou foto') },
    ])

    expect(response.statusCode).toBe(422)
    expect(storage.objects.size).toBe(0)
    expect(storage.removed.length).toBe(3)
    expect(await ownerPrisma.petPhoto.count()).toBe(0)
  })

  it('AC-05: marcar para campanha sem consentimento IMAGE_USE devolve 403', async () => {
    const petId = await givenPet()
    const uploaded = await upload(petId, [
      { filename: 'thor.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])
    const photoId = uploaded.json()[0].id as string

    const denied = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/photos/${photoId}`,
      payload: { marketingUse: true },
    })

    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('ERR_PET_010')

    // Com o consentimento registrado, a mesma marcação passa.
    await ownerPrisma.tutorConsent.create({
      data: {
        tenantId: tenant.tenantId,
        tutorId,
        channel: 'IMAGE_USE',
        granted: true,
        purpose: 'MARKETING',
        version: '1.0',
      },
    })

    const allowed = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/photos/${photoId}`,
      payload: { marketingUse: true },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().marketingUse).toBe(true)
  })

  it('AC-05: a revogação posterior vale — o consentimento é lido no momento do uso', async () => {
    const petId = await givenPet()
    const uploaded = await upload(petId, [
      { filename: 'thor.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])
    const photoId = uploaded.json()[0].id as string

    // `tutor_consents` é append-only: conceder e depois revogar são duas linhas, e
    // vale a mais recente.
    for (const granted of [true, false]) {
      await ownerPrisma.tutorConsent.create({
        data: {
          tenantId: tenant.tenantId,
          tutorId,
          channel: 'IMAGE_USE',
          granted,
          purpose: 'MARKETING',
          version: '1.0',
        },
      })
    }

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/photos/${photoId}`,
      payload: { marketingUse: true },
    })

    expect(response.statusCode).toBe(403)
  })

  it('troca a capa e devolve a galeria em ordem cronológica', async () => {
    const petId = await givenPet()
    const photo = await jpegWithExif()
    const uploaded = await upload(petId, [
      { filename: 'a.jpg', contentType: 'image/jpeg', content: photo },
      { filename: 'b.jpg', contentType: 'image/jpeg', content: photo },
    ])
    const [first, second] = uploaded.json() as { id: string }[]

    const changed = await callApi({
      ...asAdmin(tenant),
      method: 'PATCH',
      url: `/v1/pets/${petId}/photos/${second?.id}`,
      payload: { isCover: true, caption: 'Depois do banho' },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ isCover: true, caption: 'Depois do banho' })

    const album = await callApi({ ...asAdmin(tenant), method: 'GET', url: `/v1/pets/${petId}/photos` })
    const photos = album.json().photos as { id: string; isCover: boolean }[]
    expect(photos.find((item) => item.id === second?.id)?.isCover).toBe(true)
    expect(photos.find((item) => item.id === first?.id)?.isCover).toBe(false)
    expect(album.json().quota).toMatchObject({ used: 2 })
  })

  it('excluir a capa passa o posto para a próxima foto e apaga o objeto do bucket', async () => {
    const petId = await givenPet()
    const photo = await jpegWithExif()
    const uploaded = await upload(petId, [
      { filename: 'a.jpg', contentType: 'image/jpeg', content: photo },
      { filename: 'b.jpg', contentType: 'image/jpeg', content: photo },
    ])
    const [first, second] = uploaded.json() as { id: string }[]

    const response = await callApi({
      ...asAdmin(tenant),
      method: 'DELETE',
      url: `/v1/pets/${petId}/photos/${first?.id}`,
    })
    expect(response.statusCode).toBe(204)

    // §9: o objeto sai do bucket, não só a linha da tela.
    expect(storage.removed).toHaveLength(3)
    expect(storage.objects.size).toBe(3)

    const row = await ownerPrisma.petPhoto.findUniqueOrThrow({ where: { id: first?.id } })
    expect(row.deletedAt).not.toBeNull()

    const pet = await ownerPrisma.pet.findUniqueOrThrow({ where: { id: petId } })
    expect(pet.coverPhotoId).toBe(second?.id)
  })

  it('o tosador envia a foto do banho pronto, mas não edita o álbum', async () => {
    const petId = await givenPet()
    // `GROOMER` tem `pet:upload_photo` e não tem `pet:update` — a distinção que este
    // teste exercita, agora vinda da matriz em vez de uma lista escrita aqui.
    const caller = await asRole(tenant, 'GROOMER')

    const uploaded = await upload(
      petId,
      [{ filename: 'tosa.jpg', contentType: 'image/jpeg', content: await jpegWithExif() }],
      { source: 'GROOMING_RESULT' },
      caller,
    )
    expect(uploaded.statusCode).toBe(201)
    expect(uploaded.json()[0].source).toBe('GROOMING_RESULT')

    const edited = await callApi({
      ...caller,
      method: 'PATCH',
      url: `/v1/pets/${petId}/photos/${uploaded.json()[0].id}`,
      payload: { caption: 'ficou linda' },
    })
    expect(edited.statusCode).toBe(403)
  })

  it('não vaza foto de pet de outro tenant', async () => {
    const petId = await givenPet()
    await upload(petId, [
      { filename: 'thor.jpg', contentType: 'image/jpeg', content: await jpegWithExif() },
    ])

    const outsider = await givenTenant('Outro Petshop')
    const response = await callApi({
      ...asAdmin(outsider),
      method: 'GET',
      url: `/v1/pets/${petId}/photos`,
    })

    expect(response.statusCode).toBe(404)
  })
})
