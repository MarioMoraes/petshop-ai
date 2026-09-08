import { createDocumentStorage } from '@petshop/documents'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * O bucket dos documentos, visto **de fora** (MOD-NOTIF-05).
 *
 * Mesma fábrica que o ledger, o prontuário e o tutor-service usam para arquivar — e o
 * único serviço que a abre para **ler**. O anexo é a única entrega do sistema que não
 * pode sair por URL assinada: o Resend quer o conteúdo em base64 no corpo do POST.
 *
 * Não há `put` aqui por desenho, e não por esquecimento: este serviço não emite
 * documento nenhum. Quem escreve é quem sabe montar o papel.
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
