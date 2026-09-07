import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Os documentos arquivados, do lado de quem só os **entrega** (MOD-DOC-10).
 *
 * É o gêmeo do `photo-urls.ts`, e a assimetria é a mesma: quem grava documento é o
 * serviço que sabe montá-lo — o ledger para o recibo, o prontuário para o receituário, o
 * tutor-service para o termo —, cada um com o seu contador de tentativas e o seu job de
 * reprocesso. O Portal nunca escreve objeto, então a porta daqui não tem `put`: o que não
 * existe não pode ser chamado por engano.
 *
 * Assinar é **cálculo local**, sem ida ao R2. Por isso o Portal assina o que já leu do
 * banco em vez de pedir por HTTP, a três serviços diferentes, o endereço de um arquivo
 * cuja chave ele tem na mão.
 *
 * A validade é a do documento (quinze minutos), e não a da foto: o papel é aberto na
 * hora, do celular. Um endereço que vale um dia é um endereço que circula em grupo de
 * WhatsApp.
 */

export interface DocumentUrlPort {
  signedUrl(key: string, expiresInSeconds: number): Promise<string>
}

let port: DocumentUrlPort | null = null
let client: S3Client | null = null

/** Injeta um dublê. Usado pelos testes; nunca em produção. */
export function setDocumentUrlPort(next: DocumentUrlPort | null): void {
  port = next
  client = null
}

function s3(): S3Client | null {
  const env = loadEnv()
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null

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
    if (port) return await port.signedUrl(key, expiresInSeconds)

    const s3Client = s3()
    if (!s3Client) return null

    return await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: loadEnv().R2_BUCKET, Key: key }),
      { expiresIn: expiresInSeconds },
    )
  } catch (error) {
    logger.warn({ err: error, key }, 'falha ao assinar a URL do documento')
    return null
  }
}
