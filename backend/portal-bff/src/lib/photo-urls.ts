import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { PHOTO_URL_TTL_SECONDS } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * As fotos do pet, do lado de quem só as **mostra**.
 *
 * É o recorte de leitura do `storage.ts` do pet-service, e a assimetria é deliberada:
 * quem publica foto é a equipe (MOD-PET-04) ou o tutor por uma rota que ainda passa
 * pelo pipeline de imagem daquele serviço. O Portal nunca grava nem apaga objeto, então
 * a porta daqui não tem `put` nem `remove` — o que não existe não pode ser chamado por
 * engano.
 *
 * Nenhuma URL vem do banco: `pet_photos.variants` guarda **chave de objeto**, e a URL
 * sai assinada na leitura com a validade curta do RN-13 do MOD-PET. URL guardada em
 * banco nasce vencida.
 *
 * Assinar é cálculo local — não há ida ao R2 aqui —, e por isso assinar a capa de uma
 * lista inteira de pets não custa rede.
 */

export interface PhotoUrlPort {
  signedUrl(key: string): Promise<string>
}

let port: PhotoUrlPort | null = null
let client: S3Client | null = null

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setPhotoUrlPort(next: PhotoUrlPort | null): void {
  port = next
  client = null
}

function s3(): S3Client | null {
  const env = loadEnv()
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null

  client ??= new S3Client({
    region: env.R2_REGION,
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    // R2 não faz bucket como subdomínio do endpoint da conta.
    forcePathStyle: true,
  })
  return client
}

/**
 * A URL de uma variante, ou `null`.
 *
 * **Nunca lança**, e essa é a diferença que importa em relação ao pet-service: lá, o
 * storage indisponível vira 502 porque a operação *é* a foto. Aqui a foto é enfeite da
 * ficha, e derrubar "Meus pets" inteiro porque o R2 piscou tiraria do tutor o histórico,
 * a idade e o próximo agendamento por causa de um retrato.
 */
export async function signPhotoUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null

  try {
    if (port) return await port.signedUrl(key)

    const s3Client = s3()
    if (!s3Client) return null

    return await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: loadEnv().R2_BUCKET, Key: key }),
      { expiresIn: PHOTO_URL_TTL_SECONDS },
    )
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao assinar a URL da foto')
    return null
  }
}

/** A chave de uma variante dentro do `variants` de `pet_photos`. */
export function variantKey(variants: unknown, variant: 'thumb' | 'medium' | 'full'): string | null {
  if (!variants || typeof variants !== 'object') return null
  const value = (variants as Record<string, unknown>)[variant]
  return typeof value === 'string' ? value : null
}
