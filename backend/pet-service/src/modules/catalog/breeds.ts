import { withTenant, type Breed, type TenantTransaction } from '@petshop/db'
import {
  normalizeBreedLabel,
  type Breed as BreedDto,
  type CreateBreedInput,
  type ManagedBreed,
  type UpdateBreedInput,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { conflict, domainInUse, forbidden, invalid, notFound } from '../../lib/errors.js'
import { recordMetric } from '../../lib/logger.js'
import { tenantOptions, type ActorContext } from '../pets/actor.js'
import { byLabel, invalidateCatalog, toBreed } from './service.js'

/**
 * Escrita no catálogo de raças (MOD-PET-03).
 *
 * RN-02 divide o catálogo em dois espaços: o global, que o tenant lê e não toca, e o
 * do tenant, que é dele. As duas regras que sustentam isso já vivem no banco — o
 * `WITH CHECK` da política `tenant_catalog` recusa escrever linha global, e a
 * política restritiva de DELETE recusa apagá-la. O que este módulo acrescenta é a
 * mensagem: 403 explicando que dá para **ocultar** (AC-02), em vez de um erro de
 * constraint que a recepção não saberia ler.
 */

// ─── Leitura de administração ────────────────────────────────────────────────

/**
 * A lista da tela de catálogo, não a do seletor de pet: traz o que está oculto e
 * quantos pets usam cada raça, porque desativar sem saber o impacto é como AC-04
 * vira surpresa.
 */
export async function listManagedBreeds(tenantId: string, speciesId: string): Promise<ManagedBreed[]> {
  return withTenant(tenantId, async (tx) => {
    const [rows, hidden, usage] = await Promise.all([
      tx.breed.findMany({ where: { speciesId } }),
      tx.breedVisibility.findMany({ select: { breedId: true } }),
      tx.pet.groupBy({ by: ['breedId'], where: { deletedAt: null }, _count: { _all: true } }),
    ])

    const hiddenIds = new Set(hidden.map((row) => row.breedId))
    const countByBreed = new Map(
      usage.filter((row) => row.breedId !== null).map((row) => [row.breedId as string, row._count._all]),
    )

    return rows.sort(byLabel).map((row) => ({
      ...toBreed(row),
      // A raça do tenant some do seletor por `active`; a global, por
      // `breed_visibility`. Para a tela é a mesma chave.
      hidden: row.tenantId === null ? hiddenIds.has(row.id) : !row.active,
      petsCount: countByBreed.get(row.id) ?? 0,
    }))
  })
}

// ─── Criação ─────────────────────────────────────────────────────────────────

/** AC-03: "Golden Retriever" já existe no global — 409 apontando qual, não uma cópia. */
export async function createBreed(actor: ActorContext, input: CreateBreedInput): Promise<BreedDto> {
  const breed = await withTenant(
    actor.tenantId,
    async (tx) => {
      const species = await tx.species.findFirst({ where: { id: input.speciesId } })
      if (!species) {
        throw invalid('Espécie não encontrada no catálogo', [
          { field: 'speciesId', message: 'Espécie não encontrada no catálogo' },
        ])
      }
      if (input.defaultSizeId) await assertSizeExists(tx, input.defaultSizeId)

      const normalizedLabel = normalizeBreedLabel(input.label)
      await assertBreedLabelFree(tx, input.speciesId, normalizedLabel)

      const created = await tx.breed.create({
        data: {
          tenantId: actor.tenantId,
          speciesId: input.speciesId,
          label: input.label.trim(),
          normalizedLabel,
          defaultSizeId: input.defaultSizeId ?? null,
          groomingNotes: input.groomingNotes ?? null,
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'breed.created',
        entity: 'breed',
        entityId: created.id,
        after: { label: created.label, speciesId: created.speciesId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return created
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, `breeds:${breed.speciesId}`)
  // §10: o que os tenants inventam é o insumo para expandir o catálogo global.
  recordMetric({
    metric: 'pet_custom_breed_created_total',
    tenantId: actor.tenantId,
    value: 1,
    unit: 'count',
  })

  return toBreed(breed)
}

// ─── Alteração ───────────────────────────────────────────────────────────────

export async function updateBreed(
  actor: ActorContext,
  breedId: string,
  patch: UpdateBreedInput,
): Promise<BreedDto> {
  if (Object.keys(patch).length === 0) {
    const current = await withTenant(actor.tenantId, (tx) => loadBreed(tx, breedId))
    return toBreed(current)
  }

  const breed = await withTenant(
    actor.tenantId,
    async (tx) => {
      const before = await loadBreed(tx, breedId)
      assertTenantOwned(before)

      if (patch.defaultSizeId) await assertSizeExists(tx, patch.defaultSizeId)

      const normalizedLabel = patch.label === undefined ? undefined : normalizeBreedLabel(patch.label)
      if (normalizedLabel !== undefined && normalizedLabel !== before.normalizedLabel) {
        await assertBreedLabelFree(tx, before.speciesId, normalizedLabel, breedId)
      }

      const updated = await tx.breed.update({
        where: { id: breedId },
        data: {
          ...(patch.label !== undefined ? { label: patch.label.trim(), normalizedLabel } : {}),
          ...(patch.defaultSizeId !== undefined ? { defaultSizeId: patch.defaultSizeId } : {}),
          ...(patch.groomingNotes !== undefined ? { groomingNotes: patch.groomingNotes } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'breed.updated',
        entity: 'breed',
        entityId: breedId,
        before: { label: before.label, defaultSizeId: before.defaultSizeId },
        after: { label: updated.label, defaultSizeId: updated.defaultSizeId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return updated
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, `breeds:${breed.speciesId}`)
  return toBreed(breed)
}

/**
 * AC-02 e AC-04 pela mesma porta: "sumir do seletor".
 *
 * Por baixo são dois mecanismos — a raça global vira linha em `breed_visibility`, a
 * do tenant tem `active` desligado —, e essa diferença existe porque o tenant não
 * pode escrever na linha global. A tela não precisa saber disso: ela pede oculto, e
 * o pet que já usa a raça continua exibindo o rótulo normalmente.
 */
export async function setBreedVisibility(
  actor: ActorContext,
  breedId: string,
  hidden: boolean,
): Promise<ManagedBreed> {
  const speciesId = await withTenant(
    actor.tenantId,
    async (tx) => {
      const breed = await loadBreed(tx, breedId)

      if (breed.tenantId === null) {
        if (hidden) {
          await tx.breedVisibility.createMany({
            data: [{ tenantId: actor.tenantId, breedId, hiddenBy: actor.actorUserId ?? null }],
            // Esconder duas vezes é esconder uma. O índice único já garantiria, mas o
            // segundo clique da tela não deveria virar 500.
            skipDuplicates: true,
          })
        } else {
          await tx.breedVisibility.deleteMany({ where: { breedId } })
        }
      } else {
        await tx.breed.update({ where: { id: breedId }, data: { active: !hidden } })
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: hidden ? 'breed.deactivated' : 'breed.reactivated',
        entity: 'breed',
        entityId: breedId,
        after: { label: breed.label, hidden, global: breed.tenantId === null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return breed.speciesId
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, `breeds:${speciesId}`)

  const managed = await listManagedBreeds(actor.tenantId, speciesId)
  const current = managed.find((breed) => breed.id === breedId)
  if (!current) throw notFound('Raça não encontrada')
  return current
}

// ─── Exclusão ────────────────────────────────────────────────────────────────

/**
 * AC-04: raça em uso não é excluída — é desativada. Apagar a linha faria o
 * `ON DELETE SET NULL` da FK zerar a raça de 14 pets em silêncio, e o relatório por
 * raça perderia o histórico sem ninguém perceber.
 */
export async function deleteBreed(actor: ActorContext, breedId: string): Promise<void> {
  const speciesId = await withTenant(
    actor.tenantId,
    async (tx) => {
      const breed = await loadBreed(tx, breedId)
      assertTenantOwned(breed)

      const petsCount = await tx.pet.count({ where: { breedId, deletedAt: null } })
      if (petsCount > 0) {
        throw domainInUse(
          `${petsCount} ${petsCount === 1 ? 'pet usa' : 'pets usam'} esta raça. Desative-a para tirá-la do seletor.`,
          { petsCount, breedId },
        )
      }

      await tx.breed.delete({ where: { id: breedId } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'breed.deleted',
        entity: 'breed',
        entityId: breedId,
        before: { label: breed.label, speciesId: breed.speciesId },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return breed.speciesId
    },
    tenantOptions(actor),
  )

  await invalidateCatalog(actor.tenantId, `breeds:${speciesId}`)
}

// ─── Regras compartilhadas ───────────────────────────────────────────────────

async function loadBreed(tx: TenantTransaction, breedId: string): Promise<Breed> {
  const breed = await tx.breed.findFirst({ where: { id: breedId } })
  if (!breed) throw notFound('Raça não encontrada')
  return breed
}

/** AC-02: o catálogo global é da plataforma. O tenant oculta, não edita. */
function assertTenantOwned(breed: Breed): void {
  if (breed.tenantId === null) {
    throw forbidden(
      'Raças do catálogo global não podem ser alteradas. Você pode ocultá-la da sua lista.',
    )
  }
}

/**
 * AC-03: a comparação é sobre o rótulo normalizado e cobre os dois espaços — criar
 * "golden retriever" com o "Golden Retriever" global existente devolve 409 com a
 * raça equivalente, para a tela oferecer selecioná-la em vez de duplicar.
 */
async function assertBreedLabelFree(
  tx: TenantTransaction,
  speciesId: string,
  normalizedLabel: string,
  excludeBreedId?: string,
): Promise<void> {
  const existing = await tx.breed.findFirst({
    where: {
      speciesId,
      normalizedLabel,
      ...(excludeBreedId ? { id: { not: excludeBreedId } } : {}),
    },
  })
  if (!existing) return

  throw conflict(
    existing.tenantId === null
      ? 'Esta raça já existe no catálogo global'
      : 'Sua lista já tem uma raça com este nome',
    { existingBreed: toBreed(existing) },
  )
}

async function assertSizeExists(tx: TenantTransaction, sizeId: string): Promise<void> {
  const size = await tx.size.findFirst({ where: { id: sizeId } })
  if (!size) {
    throw invalid('Porte não encontrado no catálogo', [
      { field: 'defaultSizeId', message: 'Porte não encontrado no catálogo' },
    ])
  }
}
