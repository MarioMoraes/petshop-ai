import { escapeHtml } from '@petshop/pdf'

/**
 * O molde comum de todo documento formal (MOD-DOC-01).
 *
 * Função pura: entra dado, sai string. **Nenhuma engine de template** — não há nenhuma
 * no repositório, e trazer uma para imprimir um documento seria carregar uma linguagem
 * inteira (com o seu próprio escape, os seus próprios furos) para interpolar vinte
 * campos. É a mesma escolha que o `receipt-template.ts` do MOD-LEDGER já tinha feito.
 *
 * O que este arquivo guarda é o que **não** muda entre documentos: o cabeçalho de quem
 * emitiu, o rodapé com paginação, e um CSS só. O miolo continua sendo escrito pelo
 * serviço que sabe o que está imprimindo.
 */

export interface DocumentAddress {
  zip: string
  street: string
  number: string
  complement: string | null
  district: string
  city: string
  state: string
}

/**
 * Quem emitiu. Sai do MOD-IDENT e do endereço público que o MOD-SITE acrescentou em
 * 2026-08-28 — antes disso o petshop não tinha rua em lugar nenhum do schema, e
 * documento formal sem o endereço de quem emitiu é papel timbrado pela metade.
 */
export interface DocumentIssuer {
  name: string
  legalName: string | null
  /** Já decifrado pelo chamador: a DEK do tenant não atravessa a fronteira do pacote. */
  cnpj: string | null
  address: DocumentAddress | null
  phone: string | null
  logoUrl: string | null
  primaryColor: string | null
}

export interface DocumentLayoutInput {
  issuer: DocumentIssuer
  /** "Recibo de pagamento", "Receituário veterinário". Vai no topo e no rodapé. */
  title: string
  /** A série. Aparece ao lado do título e identifica o papel no rodapé. */
  number: string
  issuedAt: Date
  timezone: string
  /** O miolo, já escapado por quem o montou. */
  bodyHtml: string
  /**
   * Aviso obrigatório, quando houver. Sai **do código** de quem emite, nunca de texto
   * livre do tenant — é o que o RN-09 exige do "isto não é nota fiscal".
   */
  notice?: string | null
}

const FALLBACK_COLOR = '#232427'

/**
 * Falta dado para imprimir?
 *
 * Devolve a lista do que falta em vez de um booleano: o AC-02 de MOD-DOC-01 manda a
 * resposta 422 dizer **qual** dado falta, e um `false` obrigaria o chamador a redescobrir
 * a razão. Tenants criados antes de 2026-08-28 estão sem endereço, e é este o caminho por
 * onde eles descobrem.
 */
export function missingIssuerFields(issuer: DocumentIssuer): string[] {
  const missing: string[] = []
  if (!issuer.name.trim()) missing.push('nome do estabelecimento')
  if (!issuer.address) missing.push('endereço do estabelecimento')
  if (!issuer.phone?.trim()) missing.push('telefone do estabelecimento')
  return missing
}

export function formatAddress(address: DocumentAddress): string {
  const linha1 = [address.street, address.number].filter(Boolean).join(', ')
  const complemento = address.complement ? ` — ${address.complement}` : ''
  const cep = address.zip.length === 8 ? `${address.zip.slice(0, 5)}-${address.zip.slice(5)}` : address.zip
  return `${linha1}${complemento} · ${address.district} · ${address.city}/${address.state} · CEP ${cep}`
}

export function formatDateTime(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(value)
}

/**
 * O cabeçalho de página do Gotenberg.
 *
 * Fica **vazio** de propósito: a marca do emissor sai no corpo, uma vez, no alto da
 * primeira página. Repetir logo e endereço em toda página gastaria dois centímetros de
 * cada folha para dizer o que já foi dito.
 */
export function renderPageHeader(): string {
  return '<html><head><style>body{margin:0}</style></head><body></body></html>'
}

/**
 * O rodapé de página, com a paginação que só o Chromium sabe preencher.
 *
 * `.pageNumber` e `.totalPages` são substituídos por ele na renderização; qualquer
 * cálculo nosso exigiria saber a altura do conteúdo antes de renderizá-lo.
 */
export function renderPageFooter(input: { title: string; number: string }): string {
  const identificacao = escapeHtml(`${input.title} ${input.number}`)
  return `<html><head><style>
    body { margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .rodape { width: 100%; padding: 0 0.6in; font-size: 8px; color: #6b6d76;
              display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="rodape">
      <span>${identificacao}</span>
      <span>página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>
  </body></html>`
}

/** O documento inteiro: cabeçalho do emissor, miolo e aviso. */
export function renderDocument(input: DocumentLayoutInput): string {
  const cor = input.issuer.primaryColor ?? FALLBACK_COLOR
  const { issuer } = input

  // O logo é buscado pelo Chromium do Gotenberg, que é um navegador de verdade: a URL
  // precisa ser alcançável de dentro do container. Sem logo, o nome vira a marca — o
  // que também cobre o tenant que nunca subiu imagem nenhuma.
  const marca = issuer.logoUrl
    ? `<img class="logo" src="${escapeHtml(issuer.logoUrl)}" alt="${escapeHtml(issuer.name)}">`
    : `<span class="marca">${escapeHtml(issuer.name)}</span>`

  const identificacao = [
    issuer.legalName && issuer.legalName !== issuer.name ? escapeHtml(issuer.legalName) : null,
    issuer.cnpj ? `CNPJ ${escapeHtml(issuer.cnpj)}` : null,
    issuer.address ? escapeHtml(formatAddress(issuer.address)) : null,
    issuer.phone ? escapeHtml(issuer.phone) : null,
  ]
    .filter(Boolean)
    .map((linha) => `<div>${linha}</div>`)
    .join('')

  const aviso = input.notice
    ? `<p class="aviso">${escapeHtml(input.notice)}</p>`
    : ''

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         font-size: 11px; line-height: 1.5; color: #232427; }
  .cabecalho { display: flex; justify-content: space-between; align-items: flex-start;
               gap: 16px; border-bottom: 2px solid ${escapeHtml(cor)}; padding-bottom: 10px; }
  .logo { max-height: 48px; max-width: 180px; }
  .marca { font-size: 16px; font-weight: 600; color: ${escapeHtml(cor)}; }
  .emissor { font-size: 9px; color: #6b6d76; text-align: right; }
  .titulo { margin: 18px 0 2px; font-size: 15px; font-weight: 600; }
  .serie { font-size: 10px; color: #6b6d76; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .04em;
       color: #6b6d76; border-bottom: 1px solid #e3e4e8; padding: 6px 0; }
  td { padding: 6px 0; border-bottom: 1px solid #f0f1f4; vertical-align: top; }
  td.valor, th.valor { text-align: right; white-space: nowrap; }
  .aviso { margin-top: 24px; padding: 8px 10px; background: #f6f7f9; border-radius: 4px;
           font-size: 9px; color: #6b6d76; }
</style></head><body>
  <div class="cabecalho">
    <div>${marca}</div>
    <div class="emissor">${identificacao}</div>
  </div>
  <h1 class="titulo">${escapeHtml(input.title)}</h1>
  <div class="serie">Nº ${escapeHtml(input.number)} · emitido em ${escapeHtml(
    formatDateTime(input.issuedAt, input.timezone),
  )}</div>
  ${input.bodyHtml}
  ${aviso}
</body></html>`
}
