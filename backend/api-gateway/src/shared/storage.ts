import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Storage de mídia da galeria, atrás de uma porta.
 *
 * A porta existe pela mesma razão da do pet-service: a suíte roda sem credencial e
 * sem rede, e a falha do storage precisa ser exercitável sem derrubar um bucket de
 * verdade.
 *
 * **A diferença em relação ao álbum do pet é a leitura.** Lá a foto é entregue por URL
 * assinada de 15 minutos, porque é dado de cliente e a página que a mostra exige
 * sessão. Aqui a foto é pública e vive numa página em cache: quem lê é `readObject`,
 * e o repasse ao visitante acontece no host do tenant. O bucket continua privado — o
 * que muda é quem abre a porta.
 */

export interface StoredObject {
  body: Buffer
  contentType: string
}

export interface StoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  read(key: string): Promise<StoredObject | null>
  remove(keys: string[]): Promise<void>
}

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

export function resetStorageClient(): void {
  client = null
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

  async read(key) {
    const env = loadEnv()
    try {
      const result = await s3().send(
        new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
      )
      const body = result.Body
      if (!body) return null
      const bytes = await body.transformToByteArray()
      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType ?? 'image/webp',
      }
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error
      logger.error({ err: error, key }, 'falha ao ler objeto do storage')
      return null
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
      // Remoção é best-effort: a linha já saiu do banco e a foto já sumiu da página.
      // Objeto órfão no bucket é custo, não vazamento — o bucket é privado.
      logger.error({ err: error, keys }, 'falha ao remover objetos do storage')
    }
  },
}

export function getStorage(): StoragePort {
  return port ?? r2Port
}

/** `tenants/{tenantId}/site/{photoId}.webp` — prefixo próprio, segregado por tenant. */
export function objectKey(tenantId: string, photoId: string): string {
  return `tenants/${tenantId}/site/${photoId}.webp`
}
