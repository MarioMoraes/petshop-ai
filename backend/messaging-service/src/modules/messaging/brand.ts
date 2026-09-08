import type { DocumentIssuer } from '@petshop/documents'

/**
 * O molde de marca do e-mail (MOD-NOTIF-04).
 *
 * **Dois moldes, escolhidos pelo autor do texto.** O corpo escrito pelo petshop na tela
 * do CRM continua saindo em texto puro com o embrulho mínimo de sempre — quem edita ali
 * não escreve marcação, e um recado de WhatsApp dentro de moldura corporativa soa falso.
 * O corpo escrito pelo **produto** — boas-vindas, recibo, documento — sai daqui, com o
 * logo, a cor e o rodapé do estabelecimento. Um molde só para os dois casos pioraria um.
 *
 * A fonte é a mesma do cabeçalho do PDF (`loadIssuer`, de `@petshop/documents`), e isso
 * não é economia de código: é o que faz o recibo impresso e o e-mail que o carrega
 * dizerem o mesmo endereço e o mesmo telefone. Duas fontes divergiriam no dia em que o
 * petshop mudasse de sala.
 *
 * **Função pura, sem engine de template**, como o molde do MOD-DOC. Todo campo livre
 * passa por escape: um tutor chamado `Ana & Cia <ME>` aparece literal, e não como
 * marcação quebrada (AC-05).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A cor de queda.
 *
 * O mesmo cinza-tinta do resto do produto, e não o vermelho do `DEFAULT_BRANDING`: um
 * tenant que não escolheu cor não tem cor, e pintar o e-mail dele com a cor de fábrica
 * do produto seria vestir o petshop com uma marca que não é dele (AC-04).
 */
const FALLBACK_COLOR = '#232427'

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

/**
 * O texto puro vira parágrafos.
 *
 * Linha em branco separa parágrafo, quebra simples vira `<br>`. É a mesma leitura que
 * um humano faz do texto que o produto escreveu — e é o que permite escrever o corpo
 * dos templates sem uma linha de marcação.
 */
function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#232427">` +
        `${escapeHtml(block).replace(/\n/g, '<br>')}</p>`,
    )
    .join('')
}

/**
 * O cabeçalho: logo quando existe, o nome quando não.
 *
 * **Nenhuma informação vive só dentro da imagem** (AC-03). Boa parte dos clientes de
 * e-mail bloqueia imagem externa por padrão, e um cabeçalho que fosse só o logo
 * entregaria um e-mail sem remetente visível. O `alt` carrega o nome, e o rodapé o
 * repete por extenso.
 */
function header(issuer: DocumentIssuer, color: string): string {
  const marca = issuer.logoUrl
    ? `<img src="${escapeHtml(issuer.logoUrl)}" alt="${escapeHtml(issuer.name)}" ` +
      `height="40" style="height:40px;max-width:200px;display:block;border:0">`
    : `<span style="font-size:17px;font-weight:600;color:${color}">${escapeHtml(issuer.name)}</span>`

  return (
    `<tr><td style="padding:24px 28px 18px;border-bottom:2px solid ${color}">${marca}</td></tr>`
  )
}

/** Nome, endereço e telefone — o que diz de quem é o e-mail depois que ele é lido. */
function footer(issuer: DocumentIssuer, address: string | null): string {
  const linhas = [
    escapeHtml(issuer.legalName && issuer.legalName !== issuer.name ? issuer.legalName : issuer.name),
    address ? escapeHtml(address) : null,
    issuer.phone ? escapeHtml(issuer.phone) : null,
  ].filter((line): line is string => line !== null)

  return (
    `<tr><td style="padding:16px 28px 24px;border-top:1px solid #e8e8ea;` +
    `font-size:12px;line-height:1.5;color:#71727a">${linhas.join('<br>')}</td></tr>`
  )
}

export interface BrandEmailInput {
  issuer: DocumentIssuer
  /** Endereço já formatado, ou `null` quando o tenant não o preencheu. */
  address: string | null
  /** O corpo renderizado, em texto puro. */
  body: string
}

export function renderBrandEmail(input: BrandEmailInput): string {
  const color = input.issuer.primaryColor ?? FALLBACK_COLOR

  /**
   * Tabela e estilo em atributo, não `<style>` nem flexbox.
   *
   * Não é gosto: é o que o Outlook e o Gmail renderizam. O cliente de e-mail mais
   * comum do balcão brasileiro descarta folha de estilo e ignora layout moderno, e um
   * e-mail bonito no navegador e quebrado lá é um e-mail quebrado.
   */
  return (
    `<div style="background:#f5f5f7;padding:24px 12px;font-family:${SANS}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:560px;margin:0 auto;width:100%;background:#ffffff;` +
    `border-radius:12px;border:1px solid #e8e8ea">` +
    header(input.issuer, color) +
    `<tr><td style="padding:22px 28px 8px">${paragraphs(input.body)}</td></tr>` +
    footer(input.issuer, input.address) +
    `</table></div>`
  )
}
