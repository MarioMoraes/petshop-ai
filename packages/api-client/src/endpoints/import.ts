import {
  ImportBatchListSchema,
  ImportBatchSchema,
  ImportEntityInfoSchema,
  ImportReportSchema,
  ImportUndoResultSchema,
  type ImportRequestInput,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport } from '../transport.js'

export function importEndpoints({ request }: Transport) {
  return {
    // ─── MOD-IMPORT — a carga da base do sistema anterior ──────────────────

    /**
     * O catálogo de campos de cada passo, com o modelo CSV pronto.
     *
     * Vem do servidor e não de uma cópia no frontend: é o **mesmo** catálogo que valida
     * a carga, então o modelo que o operador baixa nunca diverge do que o sistema
     * aceita.
     */
    listImportEntities: () =>
      request({
        method: 'GET',
        path: '/v1/import/entities',
        schema: z.object({ items: z.array(ImportEntityInfoSchema) }),
      }),

    /** Confere o arquivo e devolve o relatório linha a linha. Não grava nada. */
    analyzeImport: (input: ImportRequestInput) =>
      request({
        method: 'POST',
        path: '/v1/import/analyze',
        body: input,
        schema: ImportReportSchema,
      }),

    /**
     * Grava. O `mapping` é obrigatório aqui — o servidor recusa sem ele, porque aplicar
     * quatrocentas linhas por um palpite do farejador é o que o passo de conferência
     * existe para evitar.
     */
    applyImport: (input: ImportRequestInput) =>
      request({
        method: 'POST',
        path: '/v1/import/apply',
        body: input,
        schema: ImportReportSchema,
      }),

    listImportBatches: () =>
      request({
        method: 'GET',
        path: '/v1/import/batches',
        schema: ImportBatchListSchema,
      }),

    getImportBatch: (id: string) =>
      request({
        method: 'GET',
        path: `/v1/import/batches/${id}`,
        schema: ImportBatchSchema,
      }),

    undoImportBatch: (id: string) =>
      request({
        method: 'POST',
        path: `/v1/import/batches/${id}/undo`,
        schema: ImportUndoResultSchema,
      }),
  }
}
