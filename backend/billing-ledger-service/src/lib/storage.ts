import { createDocumentStorage } from '@petshop/documents'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Armazenamento de documento — R2 pela API S3, como as fotos do MOD-PET.
 *
 * A implementação mudou de casa na fatia 1 do MOD-DOC: o mecanismo mora em
 * `@petshop/documents` e o que fica aqui é de onde vêm as credenciais. Mesma forma do
 * `lib/pdf.ts`, e pela mesma razão — um pacote não pode chamar o `loadEnv()` de um
 * serviço.
 *
 * Só `put` e `signedUrl`: documento não se apaga. A guarda de cinco anos vale também
 * para o comprovante, e um recibo cancelado continua existindo — o que muda é o
 * `status`, não o arquivo.
 */

const storage = createDocumentStorage({
  endpoint: () => loadEnv().R2_ENDPOINT,
  region: () => loadEnv().R2_REGION,
  bucket: () => loadEnv().R2_BUCKET,
  accessKeyId: () => loadEnv().R2_ACCESS_KEY_ID,
  secretAccessKey: () => loadEnv().R2_SECRET_ACCESS_KEY,
  logger,
})

export const documentStorage = storage
export const getStorage = storage.get

/** Injeta outra implementação — é o que a suíte usa. `null` volta ao real. */
export const setStoragePort = storage.setPort

export { StorageUnavailableError, documentKey } from '@petshop/documents'

/**
 * Validade da URL assinada.
 *
 * Quinze minutos: o recibo é aberto na hora, do balcão ou do e-mail. Um endereço que
 * vale um dia é um endereço que circula em grupo de WhatsApp. O valor virou
 * `DOCUMENT_URL_TTL_SECONDS` em `shared-types`; este nome fica porque o MOD-LEDGER o
 * usa em três lugares.
 */
export { DOCUMENT_URL_TTL_SECONDS as RECEIPT_URL_TTL_SECONDS } from '@petshop/shared-types'
