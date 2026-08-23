import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Storage de mídia (MOD-PET-04), atrás de uma porta.
 *
 * A porta existe pela mesma razão da do Clerk no identity-service: a suíte roda sem
 * credencial e sem rede, e o AC-04 — falha 5xx do storage vira 502 sem deixar
 * registro órfão — precisa ser testável sem derrubar um bucket de verdade.
 *
 * A implementação padrão é o R2 pela API S3. R2 é object storage puro: não há
 * variante automática nem URL de serviço. Quem gera as três variantes é o
 * `photos/image.ts`, e a URL é assinada aqui, com validade curta (RN-13).
 */

export interface StoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  /** URL de leitura assinada. Curta de propósito: 15 minutos é o teto do RN-13. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>
  remove(keys: string[]): Promise<void>
}

/** Erro de infraestrutura do storage. O serviço traduz para 502 `ERR_PET_009`. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageUnavailableError'
  }
}

let port: StoragePort | null = null
let client: S3Client | null = null

/** Injeta outra implementação — é o que a suíte usa. */
export function setStoragePort(next: StoragePort | null): void {
  port = next
}

function s3(): S3Client {
  const env = loadEnv()
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new StorageUnavailableError('Storage de mídia não configurado neste ambiente')
  }

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

const r2Port: StoragePort = {
  async put(key, body, contentType) {
    const env = loadEnv()
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      )
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error
      logger.error({ err: error, key }, 'falha ao gravar objeto no storage')
      throw new StorageUnavailableError('Falha ao enviar a imagem', { cause: error })
    }
  },

  async signedUrl(key, expiresInSeconds) {
    const env = loadEnv()
    try {
      // Assinatura é cálculo local: não há ida ao R2 aqui, e por isso assinar as
      // capas de uma listagem inteira não custa rede.
      return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
        expiresIn: expiresInSeconds,
      })
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error
      logger.error({ err: error, key }, 'falha ao assinar URL de leitura')
      throw new StorageUnavailableError('Falha ao gerar o endereço da imagem', { cause: error })
    }
  },

  async remove(keys) {
    if (keys.length === 0) return
    const env = loadEnv()
    try {
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: env.R2_BUCKET,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      )
    } catch (error) {
      // Remoção é best-effort: o `media-purge` diário reconcilia o que sobrou. Falhar
      // aqui deixaria a foto visível na tela, que é o oposto do que se pediu.
      logger.error({ err: error, keys }, 'falha ao remover objetos do storage')
    }
  },
}

export function getStorage(): StoragePort {
  return port ?? r2Port
}

/** `tenants/{tenantId}/pets/{petId}/{photoId}/{variante}.webp` (§4). */
export function objectKey(
  tenantId: string,
  petId: string,
  photoId: string,
  variant: string,
): string {
  return `tenants/${tenantId}/pets/${petId}/${photoId}/${variant}.webp`
}
