import { formatDateTime, renderDocument, type DocumentIssuer } from '@petshop/documents'
import {
  parseTermBody,
  TERM_KIND_LABELS,
  type TermBlock,
  type TermKind,
  type TermSpan,
} from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * O miolo do aceite: o texto que foi apresentado, e a prova de que foi aceito.
 *
 * Função pura, sem engine de template — a mesma escolha do recibo e do receituário. O
 * corpo do termo é **Markdown restrito** e chega aqui já em blocos: o parser mora em
 * `shared-types` porque a mesma versão do mesmo texto é desenhada duas vezes, aqui e na
 * tela que a apresenta ao tutor.
 *
 * **Todo texto passa por `escapeHtml`, o do tenant inclusive.** O corpo do termo é
 * digitado por alguém do estabelecimento e renderizado num Chromium de verdade: sem o
 * escape, um `<` num "menores de 6 meses < 3 kg" viraria marcação e sumiria da folha —
 * de um documento que tem valor jurídico.
 */

export interface TermAcceptanceData {
  number: string
  issuer: DocumentIssuer
  timezone: string
  kind: TermKind
  termTitle: string
  termVersion: string
  termBody: string
  tutorName: string
  /** CPF/CNPJ mascarado, quando houver. É o que identifica quem assinou. */
  tutorDocument: string | null
  /** Os animais do tutor no dia do aceite. Vazio é possível: cadastro sem pet ainda. */
  petNames: string[]
  acceptedAt: Date
  ipAddress: string | null
  userAgent: string | null
  sourceLabel: string
}

const AVISO =
  'Aceite eletrônico. A validade deste documento decorre do registro do consentimento ' +
  'em sistema, com data, hora, endereço de origem e identificação do dispositivo, nos ' +
  'termos do art. 10 da MP 2.200-2/2001.'

function renderSpans(spans: TermSpan[]): string {
  return spans
    .map((span) => (span.bold ? `<strong>${escapeHtml(span.text)}</strong>` : escapeHtml(span.text)))
    .join('')
}

function renderBlocks(blocks: TermBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'heading') return `<h2>${renderSpans(block.spans)}</h2>`
      if (block.type === 'list') {
        return `<ul>${block.items.map((item) => `<li>${renderSpans(item)}</li>`).join('')}</ul>`
      }
      return `<p>${renderSpans(block.spans)}</p>`
    })
    .join('')
}

export function renderTermAcceptanceHtml(data: TermAcceptanceData): string {
  const animais =
    data.petNames.length > 0
      ? `<dt>Animais</dt><dd>${data.petNames.map((name) => escapeHtml(name)).join(', ')}</dd>`
      : ''

  const bodyHtml = `
  <style>
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; }
    dt { color: #6b6d76; }
    dd { margin: 0; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
         color: #6b6d76; margin: 20px 0 4px; }
    .termo { margin-top: 20px; border-top: 1px solid #e3e3e6; padding-top: 4px; }
    .termo p { margin: 6px 0; text-align: justify; }
    .termo ul { margin: 6px 0; padding-left: 18px; }
    .prova { margin-top: 28px; padding: 10px 12px; border: 1px solid #e3e3e6; border-radius: 6px; }
    .prova .rotulo { font-size: 9px; text-transform: uppercase; letter-spacing: .05em;
                     font-weight: 700; color: #6b6d76; }
    .prova dl { margin-top: 6px; }
    .prova .agente { word-break: break-all; color: #3c3d42; }
  </style>

  <dl>
    <dt>Tutor</dt><dd>${escapeHtml(data.tutorName)}</dd>
    ${data.tutorDocument ? `<dt>Documento</dt><dd>${escapeHtml(data.tutorDocument)}</dd>` : ''}
    ${animais}
    <dt>Documento aceito</dt>
    <dd>${escapeHtml(data.termTitle)} — versão ${escapeHtml(data.termVersion)}</dd>
  </dl>

  <div class="termo">${renderBlocks(parseTermBody(data.termBody))}</div>

  <div class="prova">
    <div class="rotulo">Registro do aceite</div>
    <dl>
      <dt>Aceito em</dt>
      <dd>${escapeHtml(formatDateTime(data.acceptedAt, data.timezone))}</dd>
      <dt>Origem</dt><dd>${escapeHtml(data.sourceLabel)}</dd>
      ${data.ipAddress ? `<dt>Endereço IP</dt><dd>${escapeHtml(data.ipAddress)}</dd>` : ''}
      ${
        data.userAgent
          ? `<dt>Dispositivo</dt><dd class="agente">${escapeHtml(data.userAgent)}</dd>`
          : ''
      }
    </dl>
  </div>`

  return renderDocument({
    issuer: data.issuer,
    title: TERM_KIND_LABELS[data.kind],
    number: data.number,
    issuedAt: data.acceptedAt,
    timezone: data.timezone,
    bodyHtml,
    notice: AVISO,
  })
}
