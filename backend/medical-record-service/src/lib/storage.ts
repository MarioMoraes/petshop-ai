import { createDocumentStorage } from '@petshop/documents'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Armazenamento de documento — R2 pela API S3, como as fotos do MOD-PET.
 *
 * O mecanismo mora em `@petshop/documents`; o que fica aqui é de onde vêm as
 * credenciais. Mesma forma do `lib/pdf.ts`, e pela mesma razão — um pacote não pode
 * chamar o `loadEnv()` de um serviço.
 *
 * Só `put` e `signedUrl`: documento não se apaga. A guarda de cinco anos do RN-17 vale
 * também para o receituário, e uma prescrição anulada continua existindo — o que muda é
 * o registro, não o arquivo que o tutor levou para a farmácia.
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
