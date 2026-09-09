import { getStorage } from '../../shared/document-storage.js'
import { logger } from '../../shared/logger.js'

/**
 * Os documentos arquivados, do lado de quem só os **entrega** (MOD-DOC-10).
 *
 * É o gêmeo do `photo-urls.ts`, e a assimetria é a mesma: quem grava documento é o módulo
 * que sabe montá-lo — o `ledger` para o recibo, o `records` para o receituário, o `terms`
 * para o termo —, cada um com o seu contador de tentativas e o seu job de reprocesso. O
 * Portal nunca escreve objeto, então o que fica aqui não tem `put`: o que não existe não
 * pode ser chamado por engano.
 *
 * **Na fatia 11 este arquivo deixou de abrir o próprio `S3Client`**, pela mesma razão do
 * `photo-urls.ts`: quem fala com o R2 é `shared/document-storage.ts`, e o que fica aqui é
 * o recorte.
 *
 * Assinar é **cálculo local**, sem ida ao R2. Por isso o Portal assina o que já leu do
 * banco em vez de pedir a três módulos diferentes o endereço de um arquivo cuja chave ele
 * tem na mão.
 *
 * A validade é a do documento (quinze minutos), e não a da foto: o papel é aberto na hora,
 * do celular. Um endereço que vale um dia é um endereço que circula em grupo de WhatsApp.
 */

/**
 * A URL do documento, ou `null`.
 *
 * **Nunca lança**, como a da foto: chave ausente é documento ainda em preparo, e bucket
 * fora do ar não pode derrubar a lista inteira. Nos dois casos a tela mostra o documento
 * sem link, que é a verdade — o papel existe, o arquivo ainda não chegou.
 */
export async function signDocumentUrl(
  key: string | null | undefined,
  expiresInSeconds: number,
): Promise<string | null> {
  if (!key) return null

  try {
    return await getStorage().signedUrl(key, expiresInSeconds)
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao assinar a URL do documento')
    return null
  }
}
