import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { withTenant } from '@petshop/db'
import { SITE_PHOTO_LIMIT } from '@petshop/shared-types'
import {
  asAdmin,
  asReceptionist,
  authHeaders,
  callApi,
  callPublic,
  closeHarness,
  getApp,
  givenService,
  givenTenant,
  resetDatabase,
  useMemoryStorage,
  type TenantFixture,
} from './harness.js'

/**
 * A galeria do site (MOD-SITE-04).
 *
 * O storage é um dublê em memória: o que se prova aqui é o caminho inteiro — magic
 * bytes, reencodificação, teto, chave segregada por tenant e a leitura pública — sem
 * depender de um bucket.
 */

afterAll(closeHarness)

let objects: Map<string, { body: Buffer; contentType: string }>

beforeEach(async () => {
  await resetDatabase()
  objects = useMemoryStorage()
})

/** Um PNG de verdade: a validação é por conteúdo, não por extensão. */
async function pngBytes(size = 40): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: '#2E7D32' },
  })
    .png()
    .toBuffer()
}

async function upload(fixture: TenantFixture, body: Buffer, filename = 'fachada.png') {
  const app = await getApp()
  const boundary = '----petshopteste'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  return app.inject({
    method: 'POST',
    url: '/v1/site/photos',
    headers: {
      ...authHeadersFor(fixture),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([head, body, tail]),
  })
}

/**
 * O multipart precisa do `content-type` com `boundary`, e `callApi` fixa o dele —
 * por isso a assinatura é montada à mão aqui.
 */
function authHeadersFor(fixture: TenantFixture): Record<string, string> {
  return authHeaders(asAdmin(fixture))
}

describe('galeria (MOD-SITE-04)', () => {
  it('sobe a foto, guarda no caminho do tenant e reencoda para WebP', async () => {
    const fixture = await givenTenant()

    const response = await upload(fixture, await pngBytes())

    expect(response.statusCode).toBe(201)
    const photo = response.json()
    expect(photo.kind).toBe('HERO')

    const row = await withTenant(fixture.tenantId, (tx) => tx.sitePhoto.findFirstOrThrow())
    expect(row.storageKey).toBe(`tenants/${fixture.tenantId}/site/${row.id}.webp`)
    expect(row.contentType).toBe('image/webp')
    expect(objects.get(row.storageKey)?.contentType).toBe('image/webp')
  })

  /**
   * O EXIF some porque a imagem é reencodada, não porque removemos campo a campo: não
   * há metadado a esquecer. O formato de saída prova a reencodificação.
   */
  it('o objeto guardado é WebP, não o PNG recebido', async () => {
    const fixture = await givenTenant()
    await upload(fixture, await pngBytes())

    const stored = [...objects.values()][0]
    expect(stored).toBeDefined()
    const meta = await sharp(stored!.body).metadata()
    expect(meta.format).toBe('webp')
  })

  it('a segunda foto entra na galeria, e não vira capa', async () => {
    const fixture = await givenTenant()
    await upload(fixture, await pngBytes())

    const second = await upload(fixture, await pngBytes(60))

    expect(second.json().kind).toBe('GALLERY')
  })

  /** O que decide é o magic byte: um arquivo renomeado morre aqui. */
  it('recusa o que não é imagem, mesmo com nome de imagem', async () => {
    const fixture = await givenTenant()

    const response = await upload(fixture, Buffer.from('isto é um pdf disfarçado'), 'foto.png')

    expect(response.statusCode).toBe(422)
  })

  it('recusa a décima terceira foto', async () => {
    const fixture = await givenTenant()
    const bytes = await pngBytes()

    for (let index = 0; index < SITE_PHOTO_LIMIT; index += 1) {
      const response = await upload(fixture, bytes)
      expect(response.statusCode).toBe(201)
    }

    const excess = await upload(fixture, bytes)
    expect(excess.statusCode).toBe(422)
    expect(excess.json().code).toBe('ERR_SITE_003')
  })

  it('remover apaga a linha e o objeto', async () => {
    const fixture = await givenTenant()
    const photoId = (await upload(fixture, await pngBytes())).json().id

    const response = await callApi({
      ...asAdmin(fixture),
      method: 'DELETE',
      url: `/v1/site/photos/${photoId}`,
    })

    expect(response.statusCode).toBe(204)
    expect(objects.size).toBe(0)
    const count = await withTenant(fixture.tenantId, (tx) => tx.sitePhoto.count())
    expect(count).toBe(0)
  })

  it('a recepção não mexe nas fotos', async () => {
    const fixture = await givenTenant()

    const response = await callApi({
      ...asReceptionist(fixture),
      method: 'GET',
      url: '/v1/site/photos',
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('leitura pública da foto', () => {
  async function publishedWithPhoto() {
    const fixture = await givenTenant()
    await givenService(fixture, { priceCents: [5000] })
    const photoId = (await upload(fixture, await pngBytes())).json().id
    await callApi({ ...asAdmin(fixture), method: 'POST', url: '/v1/site/publish' })
    return { fixture, photoId }
  }

  it('entrega os bytes com cache longo, sem autenticação', async () => {
    const { fixture, photoId } = await publishedWithPhoto()

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site/photos/${photoId}?slug=${fixture.slug}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/webp')
    expect(response.headers['cache-control']).toContain('immutable')
  })

  /**
   * Sem esta checagem, o id de uma foto serviria no host de qualquer tenant — e a
   * página de um viraria vitrine do vizinho.
   */
  it('a foto de um tenant não é servida no host de outro', async () => {
    const { photoId } = await publishedWithPhoto()
    const outro = await givenTenant()
    await givenService(outro, { priceCents: [5000] })
    await callApi({ ...asAdmin(outro), method: 'POST', url: '/v1/site/publish' })

    const response = await callPublic({
      method: 'GET',
      url: `/public/v1/site/photos/${photoId}?slug=${outro.slug}`,
    })

    expect(response.statusCode).toBe(404)
  })

  /** A URL é versionada por `updated_at`: trocar a foto muda o endereço. */
  it('a página aponta para o endereço da foto no host do tenant', async () => {
    const { fixture } = await publishedWithPhoto()

    const site = (
      await callPublic({ method: 'GET', url: `/public/v1/site?slug=${fixture.slug}` })
    ).json()

    expect(site.photos).toHaveLength(1)
    expect(site.photos[0].url).toContain(`${fixture.slug}.`)
    expect(site.photos[0].url).toMatch(/\/midia\/[0-9a-f-]+\?v=\d+$/)
  })
})
