import { withTenant } from '@petshop/db'
import type { TutorExport } from '@petshop/shared-types'
import { upstreamUnavailable } from '../../lib/errors.js'
import { PdfUnavailableError, renderPdf } from '../../lib/pdf.js'
import { renderTutorExportHtml } from './export-template.js'
import { getTutorPort, type TutorCaller } from './tutor-port.js'

/**
 * AC-04 — a cópia dos dados do titular, em papel.
 *
 * **A mesma exportação, outra embalagem.** O conteúdo sai da mesma chamada que o JSON usa
 * — `GET /v1/tutors/:id/export` no tutor-service —, e é por isso que os dois formatos não
 * podem divergir: um só lugar monta o retrato, e é lá que a leitura vira `tutor.exported`
 * na trilha. Baixar em PDF exerce o direito de acesso exatamente como baixar em JSON, e a
 * prova disso fica registrada do mesmo jeito.
 *
 * **O documento não é guardado.** Como os relatórios do menu Cobrança, e ao contrário do
 * recibo, ele desce em bytes e morre. Arquivar a folha criaria uma segunda cópia dos
 * dados pessoais do titular — dentro de um bucket — só para poder entregá-la a ele, que é
 * o oposto do que o pedido significa.
 */

export interface TutorExportDocument {
  pdf: Buffer
  filename: string
}

export async function exportOwnDataPdf(
  caller: TutorCaller,
  tutorId: string,
): Promise<TutorExportDocument> {
  const data: TutorExport = await getTutorPort().exportOwnData(caller, tutorId)
  const { tenantName, timezone } = await readDocumentHeader(caller.tenantId)

  const html = renderTutorExportHtml(data, { tenantName, timezone })

  let pdf: Buffer
  try {
    pdf = await renderPdf(html)
  } catch (error) {
    // O Gotenberg fora do ar não é falha do Portal e não é 500: os dados estão inteiros,
    // é a impressão que não sai agora — e o JSON ao lado continua entregando o direito.
    if (error instanceof PdfUnavailableError) {
      throw upstreamUnavailable('Não foi possível gerar o PDF agora. Tente novamente em instantes.')
    }
    throw error
  }

  return { pdf, filename: `meus-dados-${diaDe(data.exportedAt, timezone)}.pdf` }
}

/**
 * O cabeçalho da folha: de quem são os dados e em que fuso as datas são lidas.
 *
 * Banco direto, como toda leitura do Portal. O nome do petshop aparece três vezes no
 * documento porque é ele quem responde pelo tratamento — um papel com dados pessoais e
 * sem controlador identificado não serve de nada a quem o recebe.
 */
async function readDocumentHeader(
  tenantId: string,
): Promise<{ tenantName: string; timezone: string }> {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    })
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId },
      select: { timezone: true },
    })

    return { tenantName: tenant.name, timezone: settings?.timezone ?? 'America/Sao_Paulo' }
  })
}

/**
 * O dia do arquivo, no fuso do estabelecimento.
 *
 * `toISOString().slice(0,10)` daria o dia em UTC: uma exportação feita às 22h de
 * Brasília nasceria com o nome do dia seguinte, e duas folhas da mesma noite se
 * ordenariam erradas na pasta de downloads.
 */
function diaDe(iso: string, timezone: string): string {
  const quando = new Date(iso)
  if (Number.isNaN(quando.getTime())) return 'exportacao'

  const partes = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(quando)

  return partes
}
