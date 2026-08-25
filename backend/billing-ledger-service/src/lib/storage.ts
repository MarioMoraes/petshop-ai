import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Armazenamento dos recibos — R2 pela API S3, como as fotos do MOD-PET.
 *
 * Só `put` e `signedUrl`: recibo não se apaga. A retenção contábil de 5 anos (§9) vale
 * também para o comprovante, e um recibo cancelado continua existindo — o que muda é o
 * `status`, não o arquivo.
 */

export interface ReceiptStoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  signedUrl(key: string, expiresInSeconds: number): Promise<string>
}

/** Erro de infraestrutura do storage. Deixa o recibo pendente, não derruba o pagamento. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageUnavailableError'
  }
}

let port: ReceiptStoragePort | null = null
let client: S3Client | null = null

/** Injeta outra implementação — é o que a suíte usa. `null` volta ao real. */
export function setStoragePort(next: ReceiptStoragePort | null): void {
  port = next
}

function s3(): S3Client {
  const env = loadEnv()
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new StorageUnavailableError('Storage de documentos não configurado neste ambiente')
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

const r2Port: ReceiptStoragePort = {
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
      logger.error({ err: error, key }, 'falha ao gravar recibo no storage')
      throw new StorageUnavailableError('Falha ao arquivar o recibo', { cause: error })
    }
  },

  async signedUrl(key, expiresInSeconds) {
    const env = loadEnv()
    try {
      // Assinatura é cálculo local: não há ida ao R2 aqui.
      return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), {
        expiresIn: expiresInSeconds,
      })
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error
      logger.error({ err: error, key }, 'falha ao assinar URL do recibo')
      throw new StorageUnavailableError('Falha ao gerar o endereço do recibo', { cause: error })
    }
  },
}

export function getStorage(): ReceiptStoragePort {
  return port ?? r2Port
}

/** `tenants/{tenantId}/receipts/{receiptId}.pdf`. */
export function receiptKey(tenantId: string, receiptId: string): string {
  return `tenants/${tenantId}/receipts/${receiptId}.pdf`
}

/**
 * Validade da URL assinada.
 *
 * Quinze minutos: o recibo é aberto na hora, do balcão ou do e-mail. Um endereço que
 * vale um dia é um endereço que circula em grupo de WhatsApp.
 */
export const RECEIPT_URL_TTL_SECONDS = 900
