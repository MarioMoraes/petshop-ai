import { withTenant, type Breed, type Coat, type Size, type Species, type TenantTransaction } from '@petshop/db'
import type { Breed as BreedDto, Coat as CoatDto, Size as SizeDto, Species as SpeciesDto } from '@petshop/shared-types'
import { invalid } from '../../lib/errors.js'
import { CACHE_KEYS, CACHE_TTL_SECONDS, cacheGet, cacheSet, cacheDelete } from '../../lib/redis.js'

/**
 * Catálogo de domínio (MOD-PET-03), na parte que o CRUD de pet precisa: leitura e
 * validação. A criação de raça pelo tenant e a desativação de item em uso ficam
 * para quando MOD-PET-03 entrar inteiro.
 *
 * RN-02 vive na política RLS, não aqui: `USING (tenant_id IS NULL OR tenant_id =
 * current_tenant_id())` é o que faz uma consulta comum devolver o catálogo global
 * somado ao do tenant, sem o serviço precisar unir as duas listas à mão.
 *
 * TTL de 24h (§10) porque o catálogo muda quase nunca e é lido em toda abertura do
 * formulário de pet — é o item de cache com maior retorno do módulo.
 */

function toSpecies(row: Species): SpeciesDto {
  return { id: row.id, key: row.key, label: row.label, custom: row.tenantId !== null }
}

function toBreed(row: Breed): BreedDto {
  return {
    id: row.id,
    speciesId: row.speciesId,
    label: row.label,
    defaultSizeId: row.defaultSizeId,
    groomingNotes: row.groomingNotes,
    custom: row.tenantId !== null,
  }
}

function toSize(row: Size): SizeDto {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    weightMinKg: Number(row.weightMinKg),
    weightMaxKg: Number(row.weightMaxKg),
    custom: row.tenantId !== null,
  }
}

function toCoat(row: Coat): CoatDto {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    groomingTimeFactor: Number(row.groomingTimeFactor),
    custom: row.tenantId !== null,
  }
}

/** Lê do cache ou do banco, sempre nessa ordem; falha de cache degrada em silêncio. */
async function cached<T>(tenantId: string, type: string, load: () => Promise<T>): Promise<T> {
  const key = CACHE_KEYS.catalog(tenantId, type)
  const hit = await cacheGet<T>(key)
  if (hit) return hit

  const value = await load()
  await cacheSet(key, value, CACHE_TTL_SECONDS.catalog)
  return value
}

export async function listSpecies(tenantId: string): Promise<SpeciesDto[]> {
  return cached(tenantId, 'species', async () => {
    const rows = await withTenant(tenantId, (tx) =>
      tx.species.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
    )
    return rows.map(toSpecies)
  })
}

/** AC-01 de MOD-PET-03: raças globais da espécie + as do tenant, em ordem alfabética. */
export async function listBreeds(tenantId: string, speciesId: string): Promise<BreedDto[]> {
  return cached(tenantId, `breeds:${speciesId}`, async () => {
    const rows = await withTenant(tenantId, (tx) =>
      tx.breed.findMany({ where: { speciesId, active: true }, orderBy: { label: 'asc' } }),
    )
    return rows.map(toBreed)
  })
}

export async function listSizes(tenantId: string): Promise<SizeDto[]> {
  return cached(tenantId, 'sizes', async () => {
    const rows = await withTenant(tenantId, (tx) =>
      tx.size.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
    )
    return rows.map(toSize)
  })
}

export async function listCoats(tenantId: string): Promise<CoatDto[]> {
  return cached(tenantId, 'coats', async () => {
    const rows = await withTenant(tenantId, (tx) =>
      tx.coat.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
    )
    return rows.map(toCoat)
  })
}

export async function invalidateCatalog(tenantId: string, ...types: string[]): Promise<void> {
  await cacheDelete(...types.map((type) => CACHE_KEYS.catalog(tenantId, type)))
}

// ─── Validação de referência ─────────────────────────────────────────────────

/** As linhas de catálogo que um pet aponta, já resolvidas e conferidas. */
export interface DomainRefs {
  species: Species
  breed: Breed | null
  size: Size
  coat: Coat | null
}

export interface DomainRefInput {
  speciesId: string
  breedId?: string | null | undefined
  sizeId: string
  coatId?: string | null | undefined
}

/**
 * Resolve espécie, raça, porte e pelagem em uma consulta por tabela e confere a
 * coerência entre elas.
 *
 * O 404 não serve aqui: um id de catálogo inexistente — ou de outro tenant, que o
 * RLS esconde — é dado de entrada inválido, e o formulário precisa apontar o campo.
 * Daí 422 `ERR_PET_002` com `field`, e não `ERR_PET_001`.
 */
export async function loadDomainRefs(tx: TenantTransaction, input: DomainRefInput): Promise<DomainRefs> {
  const [species, breed, size, coat] = await Promise.all([
    tx.species.findFirst({ where: { id: input.speciesId } }),
    input.breedId ? tx.breed.findFirst({ where: { id: input.breedId } }) : Promise.resolve(null),
    tx.size.findFirst({ where: { id: input.sizeId } }),
    input.coatId ? tx.coat.findFirst({ where: { id: input.coatId } }) : Promise.resolve(null),
  ])

  if (!species) {
    throw invalid('Espécie não encontrada no catálogo', [
      { field: 'speciesId', message: 'Espécie não encontrada no catálogo' },
    ])
  }
  if (input.breedId && !breed) {
    throw invalid('Raça não encontrada no catálogo', [
      { field: 'breedId', message: 'Raça não encontrada no catálogo' },
    ])
  }
  // AC-02: raça de gato com espécie cão. A checagem é do serviço porque o banco não
  // tem como amarrar `pets.species_id` a `breeds.species_id` sem uma FK composta.
  if (breed && breed.speciesId !== species.id) {
    throw invalid('A raça selecionada não pertence à espécie informada', [
      { field: 'breedId', message: 'A raça selecionada não pertence à espécie informada' },
    ])
  }
  if (!size) {
    throw invalid('Porte não encontrado no catálogo', [
      { field: 'sizeId', message: 'Porte não encontrado no catálogo' },
    ])
  }
  if (input.coatId && !coat) {
    throw invalid('Pelagem não encontrada no catálogo', [
      { field: 'coatId', message: 'Pelagem não encontrada no catálogo' },
    ])
  }

  return { species, breed, size, coat }
}
