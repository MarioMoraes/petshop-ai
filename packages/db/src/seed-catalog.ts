import { normalizeBreedLabel, type SizeKey, type SpeciesKey } from '@petshop/shared-types'
import type { PrismaClient } from '../generated/client/index.js'

/**
 * Seed do catálogo global de domínio (MOD-PET-03).
 *
 * `species`, `breeds`, `sizes` e `coats` com `tenant_id IS NULL` são a base da
 * plataforma: RN-02 os torna somente leitura para o tenant, que pode criar os seus
 * ao lado. É o que sustenta RN-01 — sem catálogo, "SRD", "vira-lata" e "sem raça
 * definida" viram três raças distintas no relatório.
 *
 * O seed é idempotente por `upsert` sobre a chave normalizada, e roda como owner
 * (superusuário), que passa por cima do RLS — o global não tem tenant a que pertencer.
 *
 * Questão 3 do PRD §11 (origem e licença de um catálogo de ~250 raças) segue aberta.
 * Esta lista é curada a partir das raças de fato atendidas em petshop brasileiro; é
 * suficiente para operar e o tenant preenche o resto pelo catálogo próprio.
 */

export interface CatalogSeedCounts {
  species: number
  sizes: number
  coats: number
  breeds: number
}

const SPECIES: { key: SpeciesKey; label: string; sortOrder: number }[] = [
  { key: 'DOG', label: 'Cão', sortOrder: 1 },
  { key: 'CAT', label: 'Gato', sortOrder: 2 },
  { key: 'BIRD', label: 'Ave', sortOrder: 3 },
  { key: 'RODENT', label: 'Roedor', sortOrder: 4 },
  { key: 'REPTILE', label: 'Réptil', sortOrder: 5 },
  // Sempre no fim do seletor, por isso o salto na ordem.
  { key: 'OTHER', label: 'Outros', sortOrder: 99 },
]

/**
 * Faixas de referência do AC-04. Servem para **avisar**, nunca para bloquear: o
 * buldogue francês de 16 kg existe, e o balcão precisa poder registrá-lo.
 */
const SIZES: { key: SizeKey; label: string; min: number; max: number; sortOrder: number }[] = [
  { key: 'SMALL', label: 'Pequeno', min: 0.05, max: 10, sortOrder: 1 },
  { key: 'MEDIUM', label: 'Médio', min: 10.01, max: 25, sortOrder: 2 },
  { key: 'LARGE', label: 'Grande', min: 25.01, max: 45, sortOrder: 3 },
  { key: 'GIANT', label: 'Gigante', min: 45.01, max: 120, sortOrder: 4 },
]

/** RN-03: o fator multiplica a duração base do banho e tosa. */
const COATS: { key: string; label: string; factor: number; sortOrder: number }[] = [
  { key: 'SHORT', label: 'Curta', factor: 1.0, sortOrder: 1 },
  { key: 'LONG', label: 'Longa', factor: 1.35, sortOrder: 2 },
  { key: 'DOUBLE', label: 'Dupla', factor: 1.5, sortOrder: 3 },
  { key: 'CURLY', label: 'Encaracolada', factor: 1.4, sortOrder: 4 },
  { key: 'HAIRLESS', label: 'Sem pelo', factor: 0.8, sortOrder: 5 },
]

interface BreedSeed {
  label: string
  size?: SizeKey
  groomingNotes?: string
}

/**
 * "SRD" abre toda espécie. É a resposta mais comum no balcão brasileiro e precisa
 * ser um item do catálogo, não um campo em branco — RN-01 de novo.
 */
const BREEDS: Record<SpeciesKey, BreedSeed[]> = {
  DOG: [
    { label: 'SRD (Sem Raça Definida)' },
    { label: 'Akita', size: 'LARGE', groomingNotes: 'Subpelo denso: exige rasqueadeira e secagem completa.' },
    { label: 'American Bully', size: 'MEDIUM' },
    { label: 'Basset Hound', size: 'MEDIUM', groomingNotes: 'Limpar dobras e orelhas a cada banho.' },
    { label: 'Beagle', size: 'MEDIUM' },
    { label: 'Bernese', size: 'GIANT' },
    { label: 'Bichon Frisé', size: 'SMALL', groomingNotes: 'Pelo encaracolado: escovar antes de molhar para não formar nó.' },
    { label: 'Border Collie', size: 'MEDIUM' },
    { label: 'Boxer', size: 'LARGE' },
    { label: 'Buldogue Francês', size: 'SMALL', groomingNotes: 'Braquicefálico: secagem sem ar quente e pausas frequentes.' },
    { label: 'Buldogue Inglês', size: 'MEDIUM', groomingNotes: 'Braquicefálico: limpar dobras faciais e evitar estresse térmico.' },
    { label: 'Cane Corso', size: 'GIANT' },
    { label: 'Cavalier King Charles', size: 'SMALL' },
    { label: 'Chihuahua', size: 'SMALL' },
    { label: 'Chow Chow', size: 'LARGE', groomingNotes: 'Pelagem dupla muito densa: reservar o dobro do tempo de secagem.' },
    { label: 'Cocker Spaniel', size: 'MEDIUM', groomingNotes: 'Orelhas longas: secar por dentro, risco alto de otite.' },
    { label: 'Dachshund', size: 'SMALL' },
    { label: 'Dálmata', size: 'MEDIUM' },
    { label: 'Doberman', size: 'LARGE' },
    { label: 'Dogo Argentino', size: 'LARGE' },
    { label: 'Fila Brasileiro', size: 'GIANT' },
    { label: 'Fox Paulistinha', size: 'SMALL' },
    { label: 'Golden Retriever', size: 'LARGE', groomingNotes: 'Subpelo: rasqueadeira e secagem completa até a raiz.' },
    { label: 'Husky Siberiano', size: 'LARGE', groomingNotes: 'Troca de pelo sazonal: agendar tosa higiênica com folga.' },
    { label: 'Jack Russell Terrier', size: 'SMALL' },
    { label: 'Labrador Retriever', size: 'LARGE' },
    { label: 'Lhasa Apso', size: 'SMALL', groomingNotes: 'Pelo longo que embaraça: desembaraçar a seco antes do banho.' },
    { label: 'Lulu da Pomerânia', size: 'SMALL', groomingNotes: 'Nunca raspar: o pelo pode não voltar (alopecia pós-tosa).' },
    { label: 'Maltês', size: 'SMALL', groomingNotes: 'Pelo branco e fino: atenção à mancha lacrimal.' },
    { label: 'Mastiff', size: 'GIANT' },
    { label: 'Pastor Alemão', size: 'LARGE' },
    { label: 'Pastor Australiano', size: 'LARGE' },
    { label: 'Pastor Belga', size: 'LARGE' },
    { label: 'Pequinês', size: 'SMALL', groomingNotes: 'Braquicefálico e de pelo longo: banho curto, secagem paciente.' },
    { label: 'Pinscher', size: 'SMALL' },
    { label: 'Pit Bull', size: 'MEDIUM' },
    { label: 'Poodle', size: 'SMALL', groomingNotes: 'Pelo encaracolado: tosa exige máquina e tempo acima da média.' },
    { label: 'Pug', size: 'SMALL', groomingNotes: 'Braquicefálico: limpar a dobra do focinho e evitar ar quente.' },
    { label: 'Rottweiler', size: 'LARGE' },
    { label: 'Salsicha', size: 'SMALL' },
    { label: 'Samoieda', size: 'LARGE', groomingNotes: 'Pelagem dupla branca: secagem completa, sob risco de dermatite.' },
    { label: 'São Bernardo', size: 'GIANT' },
    { label: 'Schnauzer', size: 'SMALL', groomingNotes: 'Barba e sobrancelhas: tosa com tesoura no rosto.' },
    { label: 'Shar Pei', size: 'MEDIUM', groomingNotes: 'Secar dobra por dobra: umidade retida vira dermatite.' },
    { label: 'Shiba Inu', size: 'MEDIUM' },
    { label: 'Shih Tzu', size: 'SMALL', groomingNotes: 'Pelo longo: desembaraçar a seco e limpar a região dos olhos.' },
    { label: 'Spitz Alemão', size: 'SMALL' },
    { label: 'Staffordshire Bull Terrier', size: 'MEDIUM' },
    { label: 'Weimaraner', size: 'LARGE' },
    { label: 'West Highland White Terrier', size: 'SMALL' },
    { label: 'Whippet', size: 'MEDIUM' },
    { label: 'Yorkshire Terrier', size: 'SMALL', groomingNotes: 'Pelo fino e liso: risco de nó atrás das orelhas.' },
  ],
  CAT: [
    { label: 'SRD (Sem Raça Definida)' },
    { label: 'Abissínio', size: 'SMALL' },
    { label: 'Angorá', size: 'SMALL', groomingNotes: 'Pelo semilongo: escovação frequente contra bola de pelo.' },
    { label: 'Bengal', size: 'SMALL' },
    { label: 'British Shorthair', size: 'SMALL' },
    { label: 'Exótico', size: 'SMALL', groomingNotes: 'Braquicefálico: limpar a dobra nasal e os olhos.' },
    { label: 'Himalaio', size: 'SMALL' },
    { label: 'Maine Coon', size: 'MEDIUM', groomingNotes: 'Pelagem longa e densa: reservar tempo extra de secagem.' },
    { label: 'Munchkin', size: 'SMALL' },
    { label: 'Norueguês da Floresta', size: 'MEDIUM' },
    { label: 'Persa', size: 'SMALL', groomingNotes: 'Pelo longo que embaraça: desembaraçar antes do banho.' },
    { label: 'Ragdoll', size: 'MEDIUM' },
    { label: 'Sagrado da Birmânia', size: 'SMALL' },
    { label: 'Scottish Fold', size: 'SMALL', groomingNotes: 'Orelhas dobradas: higienizar com cuidado redobrado.' },
    { label: 'Siamês', size: 'SMALL' },
    { label: 'Siberiano', size: 'MEDIUM' },
    { label: 'Sphynx', size: 'SMALL', groomingNotes: 'Sem pelo: banho frequente para retirar a oleosidade da pele.' },
  ],
  BIRD: [
    { label: 'SRD (Sem Raça Definida)' },
    { label: 'Agapornis', size: 'SMALL' },
    { label: 'Calopsita', size: 'SMALL' },
    { label: 'Canário', size: 'SMALL' },
    { label: 'Cacatua', size: 'SMALL' },
    { label: 'Papagaio', size: 'SMALL' },
    { label: 'Periquito', size: 'SMALL' },
    { label: 'Ring Neck', size: 'SMALL' },
  ],
  RODENT: [
    { label: 'SRD (Sem Raça Definida)' },
    { label: 'Chinchila', size: 'SMALL', groomingNotes: 'Banho de areia; nunca banho de água.' },
    { label: 'Coelho', size: 'SMALL' },
    { label: 'Gerbil', size: 'SMALL' },
    { label: 'Hamster Sírio', size: 'SMALL' },
    { label: 'Hamster Anão Russo', size: 'SMALL' },
    { label: 'Porquinho-da-índia', size: 'SMALL' },
    { label: 'Twister', size: 'SMALL' },
  ],
  REPTILE: [
    { label: 'SRD (Sem Raça Definida)' },
    { label: 'Cágado', size: 'SMALL' },
    { label: 'Dragão Barbudo', size: 'SMALL' },
    { label: 'Iguana', size: 'SMALL' },
    { label: 'Jabuti', size: 'SMALL' },
    { label: 'Tartaruga', size: 'SMALL' },
  ],
  OTHER: [{ label: 'SRD (Sem Raça Definida)' }],
}

export async function seedCatalog(prisma: PrismaClient): Promise<CatalogSeedCounts> {
  const sizeIds = new Map<string, string>()
  for (const size of SIZES) {
    const existing = await prisma.size.findFirst({ where: { key: size.key, tenantId: null } })
    const row = existing
      ? await prisma.size.update({
          where: { id: existing.id },
          data: {
            label: size.label,
            weightMinKg: size.min,
            weightMaxKg: size.max,
            sortOrder: size.sortOrder,
            active: true,
          },
        })
      : await prisma.size.create({
          data: {
            key: size.key,
            label: size.label,
            weightMinKg: size.min,
            weightMaxKg: size.max,
            sortOrder: size.sortOrder,
          },
        })
    sizeIds.set(size.key, row.id)
  }

  for (const coat of COATS) {
    const existing = await prisma.coat.findFirst({ where: { key: coat.key, tenantId: null } })
    if (existing) {
      await prisma.coat.update({
        where: { id: existing.id },
        data: {
          label: coat.label,
          groomingTimeFactor: coat.factor,
          sortOrder: coat.sortOrder,
          active: true,
        },
      })
    } else {
      await prisma.coat.create({
        data: {
          key: coat.key,
          label: coat.label,
          groomingTimeFactor: coat.factor,
          sortOrder: coat.sortOrder,
        },
      })
    }
  }

  let breedCount = 0

  for (const species of SPECIES) {
    const existing = await prisma.species.findFirst({
      where: { key: species.key, tenantId: null },
    })
    const speciesRow = existing
      ? await prisma.species.update({
          where: { id: existing.id },
          data: { label: species.label, sortOrder: species.sortOrder, active: true },
        })
      : await prisma.species.create({
          data: { key: species.key, label: species.label, sortOrder: species.sortOrder },
        })

    for (const breed of BREEDS[species.key]) {
      const normalizedLabel = normalizeBreedLabel(breed.label)
      const defaultSizeId = breed.size ? (sizeIds.get(breed.size) ?? null) : null

      const found = await prisma.breed.findFirst({
        where: { speciesId: speciesRow.id, normalizedLabel, tenantId: null },
      })
      if (found) {
        await prisma.breed.update({
          where: { id: found.id },
          data: {
            label: breed.label,
            defaultSizeId,
            groomingNotes: breed.groomingNotes ?? null,
            active: true,
          },
        })
      } else {
        await prisma.breed.create({
          data: {
            speciesId: speciesRow.id,
            label: breed.label,
            normalizedLabel,
            defaultSizeId,
            groomingNotes: breed.groomingNotes ?? null,
          },
        })
      }
      breedCount += 1
    }
  }

  return {
    species: SPECIES.length,
    sizes: SIZES.length,
    coats: COATS.length,
    breeds: breedCount,
  }
}
