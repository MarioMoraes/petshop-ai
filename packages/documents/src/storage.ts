import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Armazenamento de documento — R2 pela API S3, como as fotos do MOD-PET.
 *
 * Só `put` e `signedUrl`: **documento não se apaga**. A guarda de cinco anos do RN-17
 * vale para o arquivo, e um documento cancelado continua existindo — o que muda é o
 * `status`, não o objeto.
 *
 * Herda a implementação que vivia em `billing-ledger-service/src/lib/storage.ts` e
 * atendia só ao recibo. Como o `service-kit` e o `@petshop/pdf`, tudo aqui é **fábrica**:
 * um pacote não pode chamar o `loadEnv()` de um serviço.
 */

export interface DocumentStorageConfig {
  endpoint: () => string | undefined
  region: () => string
  bucket: () => string
  accessKeyId: () => string | undefined
  secretAccessKey: () => string | undefined
  logger: { error: (payload: Record<string, unknown>, message: string) => void }
}

export interface DocumentStoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  signedUrl(key: string, expiresInSeconds: number): Promise<string>
}

/** Erro de infraestrutura do storage. Deixa o documento pendente, não derruba o negócio. */
export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageUnavailableError'
  }
}

export interface DocumentStorage {
  get: () => DocumentStoragePort
  /** Injeta outra implementação — é o que a suíte usa. `null` volta ao real. */
  setPort: (next: DocumentStoragePort | null) => void
  isConfigured: () => boolean
}

export function createDocumentStorage(config: DocumentStorageConfig): DocumentStorage {
  let port: DocumentStoragePort | null = null
  let client: S3Client | null = null

  function s3(): S3Client {
    const endpoint = config.endpoint()
    const accessKeyId = config.accessKeyId()
    const secretAccessKey = config.secretAccessKey()
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new StorageUnavailableError('Storage de documentos não configurado neste ambiente')
    }
    client ??= new S3Client({
      region: config.region(),
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // R2 não faz bucket como subdomínio do endpoint da conta.
      forcePathStyle: true,
    })
    return client
  }

  const r2: DocumentStoragePort = {
    async put(key, body, contentType) {
      try {
        await s3().send(
          new PutObjectCommand({
            Bucket: config.bucket(),
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        )
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw error
        config.logger.error({ err: error, key }, 'falha ao arquivar documento')
        throw new StorageUnavailableError('Falha ao arquivar o documento', { cause: error })
      }
    },

    async signedUrl(key, expiresInSeconds) {
      try {
        // Assinatura é cálculo local: não há ida ao R2 aqui.
        return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: config.bucket(), Key: key }), {
          expiresIn: expiresInSeconds,
        })
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw error
        config.logger.error({ err: error, key }, 'falha ao assinar URL do documento')
        throw new StorageUnavailableError('Falha ao gerar o endereço do documento', { cause: error })
      }
    },
  }

  return {
    get: () => port ?? r2,
    setPort(next) {
      port = next
    },
    isConfigured: () =>
      port !== null ||
      Boolean(config.endpoint() && config.accessKeyId() && config.secretAccessKey()),
  }
}

/** `tenants/{tenantId}/documents/{documentId}.pdf`. */
export function documentKey(tenantId: string, documentId: string): string {
  return `tenants/${tenantId}/documents/${documentId}.pdf`
}
