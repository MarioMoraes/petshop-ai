import { createDocumentStorage } from '@petshop/documents'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * O bucket dos documentos.
 *
 * Mesma fábrica que o ledger e o portal-bff ainda usam nos processos deles, com as
 * mesmas credenciais. **Este arquivo abre as duas metades**, e desde a fatia 8 as duas
 * são usadas aqui dentro:
 *
 * - **ler** — o anexo do MOD-NOTIF-05 é a única entrega do sistema que não pode sair
 *   por URL assinada, porque o Resend quer o conteúdo em base64 no corpo do POST;
 * - **escrever** — o receituário do MOD-PRONT e o termo do MOD-DOC-06 arquivam por
 *   aqui. Até a fatia 7 este processo não emitia documento nenhum, e o comentário
 *   original dizia isso; o prontuário mudou o fato.
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
