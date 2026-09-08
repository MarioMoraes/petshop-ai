import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
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

/**
 * A porta do bucket de mídia, com as **duas** formas de leitura do sistema.
 *
 * `signedUrl` é a do álbum do pet (MOD-PET-04): a foto é dado de cliente, a página que
 * a mostra exige sessão, e a URL vale 15 minutos (RN-13). `read` é a do site
 * (MOD-SITE-04): a foto é pública, vive numa página em cache, e quem a repassa ao
 * visitante é o host do tenant — assinar ali daria uma URL que vence antes do cache.
 *
 * Eram duas portas em dois serviços, sobre o mesmo bucket e o mesmo cliente S3. A
 * consolidação as juntou; o que muda por módulo é qual das duas se usa, e por quê.
 */
export interface StoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  read(key: string): Promise<StoredObject | null>
  /** URL de leitura assinada. Curta de propósito: 15 minutos é o teto do RN-13. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>
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
      // Remoção é best-effort: a linha já saiu do banco e a foto já sumiu da página.
      // Objeto órfão no bucket é custo, não vazamento — o bucket é privado.
      logger.error({ err: error, keys }, 'falha ao remover objetos do storage')
    }
  },
}

export function getStorage(): StoragePort {
  return port ?? r2Port
}

/**
 * **A montagem da chave é de cada módulo**, e não daqui.
 *
 * O álbum do pet e a galeria do site guardam no mesmo bucket, em prefixos próprios, e
 * cada um tem o seu formato: `tenants/{t}/pets/{pet}/{foto}/{variante}.webp` contra
 * `tenants/{t}/site/{foto}.webp`. As duas funções se chamavam `objectKey` em serviços
 * diferentes; juntá-las aqui teria trocado uma pela outra em silêncio.
 */
