import { renderDocument, type DocumentIssuer } from '@petshop/documents'
import { PRESCRIPTION_TITLE, type PrescriptionItem } from '@petshop/shared-types'
import { escapeHtml } from '../records/pdf-port.js'

/**
 * O miolo do receituário.
 *
 * Função pura: entra dado, sai string. Nenhuma engine de template — a mesma escolha que
 * o recibo do MOD-LEDGER já tinha feito, e pela mesma razão: trazer uma linguagem
 * inteira (com o seu próprio escape e os seus próprios furos) para interpolar vinte
 * campos custa mais do que resolve.
 *
 * **Todo campo livre passa por `escapeHtml`.** O Gotenberg roda um Chromium de verdade,
 * e aqui o campo livre é digitado por um veterinário com pressa: um `<` numa posologia
 * ("<5 kg: meio comprimido") viraria marcação, e o comprimido sumiria da folha.
 *
 * O que este arquivo **não** guarda: o cabeçalho de quem emitiu e o rodapé com a
 * paginação. São iguais em todo documento e moram em `@petshop/documents`.
 */

export interface PrescriptionData {
  number: string
  issuer: DocumentIssuer
  timezone: string
  petName: string
  speciesLabel: string | null
  breedLabel: string | null
  tutorName: string
  vetName: string
  crmv: string
  items: PrescriptionItem[]
  instructions: string | null
  issuedAt: Date
  /**
   * Alergias e condições críticas do pet (RN-14).
   *
   * Vão em destaque, sempre, e não como nota de rodapé. O papel vai para a mão de quem
   * administra o medicamento em casa, e essa pessoa não abre o sistema — se a alergia
   * não estiver aqui, ela não existe para quem vai dar o remédio.
   */
  criticalAlerts: string[]
}

const AVISO =
  'Receituário de uso veterinário. Siga a posologia prescrita e não interrompa o ' +
  'tratamento sem orientação do médico veterinário responsável.'

export function renderPrescriptionHtml(data: PrescriptionData): string {
  const identificacao = [
    data.speciesLabel ? escapeHtml(data.speciesLabel) : null,
    data.breedLabel ? escapeHtml(data.breedLabel) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const linhas = data.items
    .map(
      (item, index) => `
        <tr>
          <td class="ordem">${index + 1}</td>
          <td>
            <div class="farmaco">${escapeHtml(item.drug)}${
              item.concentration ? ` <span class="concentracao">${escapeHtml(item.concentration)}</span>` : ''
            }</div>
            <div class="posologia">${escapeHtml(item.dosage)} · ${escapeHtml(item.frequency)}</div>
          </td>
          <td class="duracao">${item.durationDays} ${item.durationDays === 1 ? 'dia' : 'dias'}</td>
        </tr>`,
    )
    .join('')

  const alerta =
    data.criticalAlerts.length > 0
      ? `<div class="alerta">
           <div class="rotulo">Atenção — alertas críticos deste animal</div>
           <ul>${data.criticalAlerts
             .map((item) => `<li>${escapeHtml(item)}</li>`)
             .join('')}</ul>
         </div>`
      : ''

  const orientacoes = data.instructions
    ? `<h2>Orientações ao tutor</h2>
       <p class="orientacoes">${escapeHtml(data.instructions)}</p>`
    : ''

  const bodyHtml = `
  <style>
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; }
    dt { color: #6b6d76; }
    dd { margin: 0; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
         color: #6b6d76; margin: 24px 0 4px; }
    td.ordem, th.ordem { width: 24px; color: #6b6d76; }
    td.duracao, th.duracao { width: 20%; text-align: right; white-space: nowrap; }
    .farmaco { font-weight: 600; }
    .concentracao { font-weight: 400; color: #6b6d76; }
    .posologia { color: #3c3d42; }
    .orientacoes { white-space: pre-wrap; }
    .alerta { margin: 18px 0 0; padding: 10px 12px; border: 1px solid #c0392b;
              border-radius: 6px; }
    .alerta .rotulo { font-size: 9px; text-transform: uppercase; letter-spacing: .05em;
                      font-weight: 700; color: #c0392b; }
    .alerta ul { margin: 4px 0 0; padding-left: 16px; }
    .assinatura { margin-top: 48px; }
    .assinatura .linha { border-top: 1px solid #232427; width: 260px; padding-top: 4px; }
    .assinatura .registro { color: #6b6d76; }
  </style>

  <dl>
    <dt>Paciente</dt><dd>${escapeHtml(data.petName)}${identificacao ? ` — ${identificacao}` : ''}</dd>
    <dt>Tutor</dt><dd>${escapeHtml(data.tutorName)}</dd>
  </dl>

  ${alerta}

  <h2>Prescrição</h2>
  <table>
    <thead>
      <tr><th class="ordem"></th><th>Medicamento e posologia</th><th class="duracao">Duração</th></tr>
    </thead>
    <tbody>${linhas}</tbody>
  </table>

  ${orientacoes}

  <div class="assinatura">
    <div class="linha">${escapeHtml(data.vetName)}</div>
    <div class="registro">CRMV ${escapeHtml(data.crmv)}</div>
  </div>`

  return renderDocument({
    issuer: data.issuer,
    title: PRESCRIPTION_TITLE,
    number: data.number,
    issuedAt: data.issuedAt,
    timezone: data.timezone,
    bodyHtml,
    notice: AVISO,
  })
}
