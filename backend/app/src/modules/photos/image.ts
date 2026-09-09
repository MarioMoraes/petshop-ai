import sharp from 'sharp'
import {
  MAX_PHOTO_BYTES,
  PHOTO_VARIANTS,
  PHOTO_VARIANT_WIDTHS,
  sniffImageMime,
  type PhotoVariant,
} from '@petshop/shared-types'
import { invalidFile } from '../pets/errors.js'

/**
 * Validação e processamento da imagem (AC-02, RN-12).
 *
 * Duas garantias saem daqui, e as duas dependem de olhar o **conteúdo**:
 *
 *   1. É mesmo uma imagem? A extensão e o `content-type` são declarações do cliente.
 *      O que decide é o magic byte, e um `.pdf` renomeado morre aqui.
 *   2. O EXIF sumiu? A foto tirada no celular carrega o GPS da casa do tutor. Não
 *      removemos o metadado campo a campo: reencodamos tudo para WebP, e o metadado
 *      simplesmente não é copiado. É mais barato e não tem como esquecer um campo.
 */

export interface ProcessedVariant {
  variant: PhotoVariant
  body: Buffer
  bytes: number
}

export interface ProcessedImage {
  /** O mime real, descoberto no conteúdo — não o que o cliente disse. */
  mimeType: string
  /** Tamanho do arquivo recebido, para a métrica de consumo do §10. */
  originalBytes: number
  variants: ProcessedVariant[]
}

export async function processPhoto(input: Buffer, declaredName?: string): Promise<ProcessedImage> {
  if (input.length === 0) {
    throw invalidFile('Arquivo vazio. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.')
  }
  if (input.length > MAX_PHOTO_BYTES) {
    throw invalidFile('Formato inválido. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.')
  }

  const mimeType = sniffImageMime(input)
  if (!mimeType) {
    throw invalidFile('Formato inválido. Envie JPG, PNG, WEBP ou HEIC de até 10 MB.')
  }

  const variants: ProcessedVariant[] = []
  for (const variant of PHOTO_VARIANTS) {
    // `withoutEnlargement`: uma foto de 300px não vira 1600px borrada só para caber
    // no nome da variante.
    const body = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: PHOTO_VARIANT_WIDTHS[variant], withoutEnlargement: true })
      .webp({ quality: variant === 'thumb' ? 70 : 82 })
      .toBuffer()
      .catch((error: unknown) => {
        // Magic byte certo e decodificação quebrada é arquivo truncado ou corrompido:
        // continua sendo entrada inválida, não falha do servidor.
        throw invalidFile(
          `Não conseguimos processar ${declaredName ?? 'a imagem'}. O arquivo parece corrompido.`,
          error,
        )
      })

    variants.push({ variant, body, bytes: body.length })
  }

  return { mimeType, originalBytes: input.length, variants }
}

/** `.rotate()` sem argumento aplica a orientação do EXIF antes de descartá-lo. */
export function variantWidths(): Record<PhotoVariant, number> {
  return PHOTO_VARIANT_WIDTHS
}
