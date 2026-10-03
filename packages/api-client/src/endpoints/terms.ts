import {
  DocumentViewSchema,
  TermAcceptanceViewSchema,
  TermVersionViewSchema,
  TermVersionsResponseSchema,
  type AcceptTermInput,
  type PublishTermVersionInput,
  type TermKind,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport } from '../transport.js'

export function termEndpoints({ request }: Transport) {
  return {
    // ─── Termos versionados e aceites (MOD-DOC-06, 07 e 08) ────────────────

    /** Todas as versões publicadas, com a contagem de aceites de cada uma. */
    listTermVersions: () =>
      request({ method: 'GET', path: '/v1/terms', schema: TermVersionsResponseSchema }),

    /** O texto vigente — é o que a tela apresenta antes de colher o aceite. */
    getCurrentTerm: (kind: TermKind) =>
      request({
        method: 'GET',
        path: `/v1/terms/current/${kind}`,
        schema: TermVersionViewSchema,
      }),

    /**
     * Publica uma versão nova. Não existe edição: republicar um número já publicado
     * devolve 409 `ERR_DOC_004`, porque alguém já aceitou aquele texto.
     */
    publishTermVersion: (input: PublishTermVersionInput) =>
      request({
        method: 'POST',
        path: '/v1/terms',
        body: input,
        schema: TermVersionViewSchema,
      }),

    /** Registra o aceite e emite o papel. 409 quando a mesma versão já foi aceita. */
    acceptTerm: (tutorId: string, input: AcceptTermInput) =>
      request({
        method: 'POST',
        path: `/v1/tutors/${tutorId}/term-acceptances`,
        body: input,
        schema: TermAcceptanceViewSchema,
      }),

    listTutorDocuments: (tutorId: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/documents`,
        schema: z.object({ documents: z.array(DocumentViewSchema) }),
      }),

    /**
     * O detalhe traz a URL assinada de 15 minutos — e pedi-la **é** o download: esta
     * chamada entra na trilha de auditoria. A listagem não assina nada.
     */
    getTutorDocument: (tutorId: string, documentId: string) =>
      request({
        method: 'GET',
        path: `/v1/tutors/${tutorId}/documents/${documentId}`,
        schema: DocumentViewSchema,
      }),
  }
}
