import {
  formatCEP,
  formatCNPJ,
  formatCPF,
  formatPhoneBR,
  type ConsentRecord,
  type TutorExport,
} from '@petshop/shared-types'
import { escapeHtml } from './pdf-port.js'

/**
 * A folha "Meus dados" — a exportação do AC-04 impressa para o titular.
 *
 * **Por que existe.** O mesmo conteúdo já descia em JSON, e continua descendo: o art. 19
 * da LGPD fala em formato "de uso comum e leitura por máquina", e é o JSON que atende a
 * portabilidade de verdade — o arquivo que outro fornecedor consegue importar. Só que
 * quem clica em "baixar meus dados" no Portal quase nunca é uma máquina: é uma pessoa
 * querendo **ler** o que o petshop sabe sobre ela. Um arquivo que ela abre e não entende
 * atende o artigo e não atende a pessoa.
 *
 * Função pura e sem engine de template, como os documentos do `billing-ledger-service`, e
 * pela mesma razão dura: **todo campo livre passa por `escapeHtml`**. O Gotenberg é um
 * Chromium de verdade, e aqui entra a anotação da recepção, que é texto que ninguém
 * validou.
 *
 * O que separa esta folha dos relatórios do balcão é o leitor. Aquilo é papel de
 * trabalho — denso, tabelado, para conferir com o telefone na mão. Esta é
 * **correspondência**: campo com rótulo em português, um assunto por bloco, e o que não
 * existe dito como "não informado" em vez de sumir. Um campo ausente faz o titular
 * pensar que o dado foi omitido; escrito, ele sabe que a linha está vazia.
 */

const CANAL: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
  SMS: 'SMS',
  TERMS: 'Termos de uso',
  IMAGE_USE: 'Uso de imagem',
}

const FINALIDADE: Record<string, string> = {
  TRANSACTIONAL: 'Avisos do atendimento',
  MARKETING: 'Promoções e novidades',
  BOTH: 'Avisos e promoções',
}

const ORIGEM: Record<string, string> = {
  STAFF_FORM: 'no balcão',
  PORTAL: 'pelo Portal',
  SITE: 'pelo site',
  WHATSAPP: 'pelo WhatsApp',
  IMPORT: 'na importação do cadastro',
}

const PESSOA: Record<string, string> = { PF: 'Pessoa física', PJ: 'Pessoa jurídica' }

const SITUACAO: Record<string, string> = {
  ACTIVE: 'Ativo',
  INACTIVE: 'Inativo',
  MERGED: 'Unificado com outro cadastro',
  ANONYMIZED: 'Anonimizado',
}

export interface ExportDocumentOptions {
  /** O petshop que guarda os dados. É ele quem responde pelo tratamento. */
  tenantName: string
  /** Fuso do estabelecimento: as datas do documento são lidas onde ele fica. */
  timezone: string
}

export function renderTutorExportHtml(
  data: TutorExport,
  options: ExportDocumentOptions,
): string {
  const tutor = data.tutor
  const nome = texto(tutor, 'socialName') ?? texto(tutor, 'fullName') ?? 'Cliente'
  const emitido = dataHora(data.exportedAt, options.timezone)

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Meus dados — ${escapeHtml(options.tenantName)}</title>
<style>
  /* Sem fonte externa: o Gotenberg roda isolado e uma fonte que não carrega vira
     tempo de espera e depois um fallback qualquer. */
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt;
         margin: 0; line-height: 1.45; }

  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  header h1 { font-size: 15pt; margin: 0; }
  header .sub { margin: 4px 0 0; color: #555; }

  .intro { margin: 16px 0 0; padding: 10px 12px; background: #f4f4f2; border-radius: 6px;
           font-size: 9.5pt; color: #444; }

  h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.05em;
       color: #555; margin: 24px 0 8px; border-bottom: 1px solid #ddd;
       padding-bottom: 4px; }

  /* Rótulo e valor em duas colunas: o olho desce pela coluna da esquerda procurando o
     campo, e é assim que se lê um documento de cadastro. */
  dl { margin: 0; }
  dl > div { display: flex; gap: 12px; padding: 3px 0; border-bottom: 1px solid #f2f2f2; }
  dt { width: 11rem; flex: none; color: #555; font-size: 9.5pt; }
  dd { margin: 0; flex: 1; }
  /* O que não existe é dito, não omitido: campo ausente faz o titular achar que o dado
     foi escondido. */
  dd.vazio { color: #999; }

  .bloco { padding: 9px 11px; background: #fafafa; border-radius: 6px; margin-top: 8px; }
  .bloco h3 { font-size: 10.5pt; margin: 0 0 4px; }
  .bloco p { margin: 0; color: #444; }
  .bloco .marca { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em;
                  color: #555; }

  .livre { white-space: pre-wrap; }
  .vazio-secao { color: #777; font-size: 9.5pt; margin: 0; }

  .etiquetas { margin: 0; padding: 0; list-style: none; }
  .etiquetas li { display: inline-block; border: 1px solid #ddd; border-radius: 999px;
                  padding: 2px 9px; margin: 0 5px 5px 0; font-size: 9pt; }

  ul.consentimentos { margin: 0; padding: 0; list-style: none; }
  ul.consentimentos li { padding: 4px 0; border-bottom: 1px solid #f2f2f2; }
  .sim { color: #15803d; font-weight: bold; }
  .nao { color: #b91c1c; font-weight: bold; }

  /* Nenhum bloco é partido ao meio pela quebra de página. */
  section, .bloco, dl > div, ul.consentimentos li { page-break-inside: avoid; }

  footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ddd;
           font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(options.tenantName)}</h1>
    <p class="sub">Cópia dos seus dados · ${escapeHtml(nome)}</p>
  </header>

  <p class="intro">
    Este documento reúne tudo o que o ${escapeHtml(options.tenantName)} guarda sobre você no
    cadastro, na data em que foi gerado. É o seu direito de acesso previsto na Lei Geral de
    Proteção de Dados. Emitido em ${escapeHtml(emitido)}.
  </p>

  <section>
    <h2>Seus dados de cadastro</h2>
    <dl>
      ${linha('Nome', texto(tutor, 'fullName'))}
      ${linha('Nome social', texto(tutor, 'socialName'))}
      ${linha('Razão social', texto(tutor, 'legalName'))}
      ${linha('Tipo de cadastro', rotulo(PESSOA, texto(tutor, 'personType')))}
      ${/* Documento e telefone descem crus da exportação — é o valor gravado, não o
            exibido. Quem lê a folha é a pessoa: 15459858801 é o mesmo dado que
            154.598.588-01 e só um dos dois se confere de relance. */ ''}
      ${linha('CPF', aplicar(formatCPF, texto(tutor, 'cpf')))}
      ${linha('CNPJ', aplicar(formatCNPJ, texto(tutor, 'cnpj')))}
      ${linha('Telefone', aplicar(formatPhoneBR, texto(tutor, 'phone')))}
      ${linha('Telefone alternativo', aplicar(formatPhoneBR, texto(tutor, 'phoneAlt')))}
      ${linha('E-mail', texto(tutor, 'email'))}
      ${linha('Data de nascimento', diaPorExtenso(texto(tutor, 'birthDate')))}
      ${linha('Cliente desde', dataDeISO(texto(tutor, 'createdAt'), options.timezone))}
      ${linha('Situação', rotulo(SITUACAO, texto(tutor, 'status')))}
    </dl>
  </section>

  <section>
    <h2>Endereços</h2>
    ${enderecos(data.addresses)}
  </section>

  <section>
    <h2>Autorizações de contato</h2>
    ${consentimentos(data.consents, options.timezone)}
  </section>

  <section>
    <h2>Marcadores do cadastro</h2>
    ${etiquetas(data.tags)}
  </section>

  <section>
    <h2>Anotações do estabelecimento</h2>
    ${anotacoes(texto(tutor, 'notes'))}
  </section>

  <footer>
    Documento gerado pelo Portal do Tutor do ${escapeHtml(options.tenantName)} em
    ${escapeHtml(emitido)}. Encontrou algo errado? Fale com o estabelecimento — a correção
    dos seus dados também é um direito seu.
  </footer>
</body>
</html>`
}

/** Uma linha de rótulo e valor. Sem valor, a linha continua — dizendo que está vazia. */
function linha(rotuloTexto: string, valor: string | null): string {
  return valor
    ? `<div><dt>${escapeHtml(rotuloTexto)}</dt><dd>${escapeHtml(valor)}</dd></div>`
    : `<div><dt>${escapeHtml(rotuloTexto)}</dt><dd class="vazio">não informado</dd></div>`
}

function enderecos(lista: TutorExport['addresses']): string {
  if (lista.length === 0) {
    return '<p class="vazio-secao">Nenhum endereço cadastrado.</p>'
  }

  return lista
    .map((endereco) => {
      const rua = [texto(endereco, 'street'), texto(endereco, 'number')]
        .filter(Boolean)
        .join(', ')
      const complemento = texto(endereco, 'complement')
      const bairro = [texto(endereco, 'district'), cidadeEstado(endereco)]
        .filter(Boolean)
        .join(' · ')
      const cep = aplicar(formatCEP, texto(endereco, 'zipCode'))
      const acesso = texto(endereco, 'accessNotes')

      return `<div class="bloco">
      <h3>${escapeHtml(texto(endereco, 'label') ?? 'Endereço')}${
        endereco.isPrimary === true ? ' <span class="marca">principal</span>' : ''
      }</h3>
      <p>${escapeHtml(rua || 'Endereço sem logradouro')}${
        complemento ? ` — ${escapeHtml(complemento)}` : ''
      }</p>
      <p>${escapeHtml(bairro)}${cep ? ` · CEP ${escapeHtml(cep)}` : ''}</p>
      ${acesso ? `<p class="livre">Como chegar: ${escapeHtml(acesso)}</p>` : ''}
    </div>`
    })
    .join('\n')
}

/**
 * O histórico inteiro, e não só o estado atual.
 *
 * `tutor_consents` é append-only de propósito (PRD de tutores §6): cada linha é uma
 * decisão datada, e é a sequência delas que responde "desde quando eu autorizo isto".
 * Resumir para o valor de hoje entregaria ao titular menos do que o JSON já lhe dava.
 */
function consentimentos(lista: ConsentRecord[], timezone: string): string {
  if (lista.length === 0) {
    return '<p class="vazio-secao">Nenhuma autorização registrada.</p>'
  }

  return `<ul class="consentimentos">${lista
    .map((consent) => {
      const quando = dataHora(consent.createdAt, timezone)
      const marca = consent.granted
        ? '<span class="sim">Autorizado</span>'
        : '<span class="nao">Recusado</span>'

      return `<li>${marca} — ${escapeHtml(rotulo(CANAL, consent.channel) ?? consent.channel)}
      · ${escapeHtml(rotulo(FINALIDADE, consent.purpose) ?? consent.purpose)}
      · registrado ${escapeHtml(rotulo(ORIGEM, consent.source) ?? consent.source)} em
      ${escapeHtml(quando)}</li>`
    })
    .join('\n')}</ul>`
}

/**
 * As etiquetas do cadastro, do jeito que a equipe as vê.
 *
 * Entram porque **são dado sobre o titular** e já iam no JSON — "cliente VIP" e
 * "inadimplente" inclusive. Omitir no papel o que o arquivo entrega seria escolher o
 * que o direito de acesso alcança, e essa escolha não é nossa.
 */
function etiquetas(lista: TutorExport['tags']): string {
  if (lista.length === 0) {
    return '<p class="vazio-secao">Nenhum marcador no seu cadastro.</p>'
  }

  return `<ul class="etiquetas">${lista
    .map((tag) => `<li>${escapeHtml(tag.label)}</li>`)
    .join('')}</ul>`
}

function anotacoes(valor: string | null): string {
  if (!valor) {
    return '<p class="vazio-secao">Nenhuma anotação sobre o seu cadastro.</p>'
  }
  return `<p class="livre">${escapeHtml(valor)}</p>`
}

function cidadeEstado(endereco: Record<string, unknown>): string {
  const cidade = texto(endereco, 'city')
  const estado = texto(endereco, 'state')
  if (cidade && estado) return `${cidade}/${estado}`
  return cidade ?? estado ?? ''
}

/** Aplica um formatador só quando há o que formatar. */
function aplicar(formatador: (valor: string) => string, valor: string | null): string | null {
  return valor === null ? null : formatador(valor)
}

/**
 * Um campo do registro cru.
 *
 * `TutorExport.tutor` é `Record<string, unknown>` no contrato — a exportação é o retrato
 * da linha, e o schema não a congela campo a campo de propósito. O preço é este leitor:
 * o que não for texto com conteúdo vira `null` e a folha diz "não informado", em vez de
 * imprimir `[object Object]` no documento de alguém.
 */
function texto(registro: Record<string, unknown>, campo: string): string | null {
  const valor = registro[campo]
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  return limpo.length > 0 ? limpo : null
}

function rotulo(mapa: Record<string, string>, chave: string | null): string | null {
  if (!chave) return null
  return mapa[chave] ?? chave
}

/** `YYYY-MM-DD` como o titular escreveria. Ver `porExtenso` da tela. */
function diaPorExtenso(valor: string | null): string | null {
  if (!valor) return null
  // `T12:00` e não a data crua: `new Date('1990-04-12')` é meia-noite UTC, que em
  // Brasília cai no dia 11 — um aniversário impresso um dia antes.
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(
    new Date(`${valor}T12:00:00`),
  )
}

function dataDeISO(valor: string | null, timezone: string): string | null {
  if (!valor) return null
  const quando = new Date(valor)
  if (Number.isNaN(quando.getTime())) return null
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: timezone }).format(quando)
}

function dataHora(valor: string, timezone: string): string {
  const quando = new Date(valor)
  if (Number.isNaN(quando.getTime())) return valor
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(quando)
}
