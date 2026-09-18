import {
  CreateBreedSchema,
  ImportPetSchema,
  ListPetsQuerySchema,
  UpdatePetSchema,
  type Breed,
  type Coat,
  type CreatePetInput,
  type Size,
  type Species,
  type UpdatePetInput,
} from '@petshop/shared-types'
import { createBreed } from '../catalog/breeds.js'
import { listBreeds, listCoats, listSizes, listSpecies } from '../catalog/service.js'
import type { ActorContext } from '../pets/actor.js'
import { createPet, deletePet, listPets, updatePet } from '../pets/service.js'

/**
 * A porta para o MOD-PET.
 *
 * Como a do tutor: nenhum `INSERT` de pet mora aqui. O animal importado nasce pelo
 * mesmo `createPet` do formulário — microchip cifrado e único, vínculo com o
 * responsável principal, evento e trilha.
 *
 * **O catálogo de domínio é lido inteiro, uma vez por carga**, e não consultado por
 * linha. Resolver "Golden Retriever" em quatrocentas linhas seriam quatrocentas idas ao
 * banco para responder a mesma pergunta; e é catálogo pequeno e estável, que o próprio
 * MOD-PET já serve cacheado por 24h.
 */

export interface PetRef {
  id: string
  name: string
}

/** O catálogo de domínio, carregado uma vez por carga. */
export interface PetCatalog {
  species: Species[]
  sizes: Size[]
  coats: Coat[]
  /** Por espécie: a raça existe dentro de uma, e "Persa" de gato não serve a cão. */
  breedsBySpecies: Map<string, Breed[]>
}

export interface PetPort {
  loadCatalog(tenantId: string): Promise<PetCatalog>
  /**
   * Cadastra a raça que a planilha trouxe e o catálogo não tinha.
   *
   * Deliberado, e o mesmo que o catálogo de tipos faz em qualquer migração: a lista de
   * raças é o vocabulário da clientela ("Vira-lata caramelo", "Spitz alemão"), não
   * nosso. Recusar a linha por uma raça não cadastrada obrigaria o operador a adivinhar
   * a lista inteira ANTES de importar — e a saída fácil seria deixar a coluna de fora,
   * perdendo o dado.
   */
  createBreed(actor: ActorContext, speciesId: string, label: string): Promise<Breed>
  /** Os pets vivos de um tutor — é por eles que a chave natural (tutor + nome) resolve. */
  listByTutor(tenantId: string, tutorId: string): Promise<PetRef[]>
  create(actor: ActorContext, input: CreatePetInput): Promise<PetRef>
  update(actor: ActorContext, petId: string, patch: UpdatePetInput): Promise<void>
  remove(actor: ActorContext, petId: string): Promise<void>
}

function createInProcessPort(): PetPort {
  return {
    async loadCatalog(tenantId) {
      const [species, sizes, coats] = await Promise.all([
        listSpecies(tenantId),
        listSizes(tenantId),
        listCoats(tenantId),
      ])

      const breedsBySpecies = new Map<string, Breed[]>()
      for (const one of species) {
        breedsBySpecies.set(one.id, await listBreeds(tenantId, one.id))
      }

      return { species, sizes, coats, breedsBySpecies }
    },

    createBreed(actor, speciesId, label) {
      return createBreed(actor, CreateBreedSchema.parse({ speciesId, label }))
    },

    async listByTutor(tenantId, tutorId) {
      const page = await listPets(tenantId, ListPetsQuerySchema.parse({ tutorId, limit: 100 }))
      return page.data.map((pet) => ({ id: pet.id, name: pet.name }))
    },

    async create(actor, input) {
      /**
       * `ImportPetSchema` e não `CreatePetSchema`: a regra "informe nascimento ou idade"
       * é da tela, onde o tutor está na frente e se pergunta. Numa planilha exportada a
       * idade pode não existir em coluna nenhuma, e recusar quatrocentos pets por isso
       * obrigaria a inventar a idade de cada um. O banco já sabe dizer "não sei"
       * (`birth_date_precision = UNKNOWN`), e é o que o pet importado sem idade recebe.
       */
      const pet = await createPet(actor, ImportPetSchema.parse(input) as CreatePetInput)
      return { id: pet.id, name: pet.name }
    },

    async update(actor, petId, patch) {
      await updatePet(actor, petId, UpdatePetSchema.parse(patch))
    },

    async remove(actor, petId) {
      await deletePet(actor, petId)
    },
  }
}

let port: PetPort | null = null

export function getPetPort(): PetPort {
  port ??= createInProcessPort()
  return port
}

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setPetPort(next: PetPort | null): void {
  port = next
}
