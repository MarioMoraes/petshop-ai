'use server'

import { ApiError, type ImportRequestInput } from '@petshop/api-client'
import { revalidatePath } from 'next/cache'
import { serverApi } from '@/lib/api'
import type { ImportReport, ImportUndoResult } from '@petshop/api-client'

/**
 * As ações da importação da base anterior.
 *
 * O arquivo viaja como **data URL base64 no JSON**. Quem o lê é o componente de
 * cliente, com `FileReader`; aqui ele só é repassado. Não é multipart porque o CSV
 * precisa chegar ao servidor em bytes — quem decide a codificação é o farejador, olhando
 * o conteúdo, e um `Server Action` que recebesse texto já teria destruído os acentos de
 * todo arquivo salvo pelo Excel em pt-BR.
 *
 * **O conteúdo é enviado duas vezes** (conferir, depois aplicar), de propósito.
 * Guardá-lo no servidor entre os dois passos criaria mais um lugar com a base inteira do
 * cliente e um estado que expira — "seu envio não está mais disponível", justamente
 * depois de o operador conferir quatrocentas linhas. O SHA-256 que o backend grava no
 * lote é o que prova que o aplicado é o que foi conferido.
 */

const IMPORTACAO = '/configuracoes/importacao'

export interface ImportActionResult {
  ok: boolean
  error?: string
  report?: ImportReport
}

function falha(error: unknown, padrao: string): ImportActionResult {
  return { ok: false, error: error instanceof ApiError ? error.message : padrao }
}

/** Confere o arquivo e devolve o relatório linha a linha. **Não grava nada.** */
export async function conferirImportacao(input: ImportRequestInput): Promise<ImportActionResult> {
  try {
    return { ok: true, report: await serverApi().analyzeImport(input) }
  } catch (error) {
    return falha(error, 'Não foi possível ler o arquivo.')
  }
}

/**
 * Grava.
 *
 * O `mapping` é obrigatório aqui — o backend recusa sem ele, e a checagem repetida deste
 * lado poupa uma ida ao servidor para dizer o que a tela já sabe.
 */
export async function aplicarImportacao(input: ImportRequestInput): Promise<ImportActionResult> {
  if (!input.mapping || Object.keys(input.mapping).length === 0) {
    return { ok: false, error: 'Confirme o mapeamento das colunas antes de aplicar.' }
  }

  try {
    const report = await serverApi().applyImport(input)
    revalidatePath(IMPORTACAO)
    return { ok: true, report }
  } catch (error) {
    return falha(error, 'Não foi possível aplicar a importação.')
  }
}

export interface DesfazerResult {
  ok: boolean
  error?: string
  resultado?: ImportUndoResult
}

export async function desfazerImportacao(batchId: string): Promise<DesfazerResult> {
  try {
    const resultado = await serverApi().undoImportBatch(batchId)
    revalidatePath(IMPORTACAO)
    return { ok: true, resultado }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError ? error.message : 'Não foi possível desfazer o lote.',
    }
  }
}
