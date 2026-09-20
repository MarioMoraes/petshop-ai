/**
 * Gera os modelos Dart do app do tutor a partir dos schemas Zod do backend.
 *
 * O contrato do Portal já está escrito uma vez, em `../src/portal.ts`. Redigitá-lo em
 * Dart criaria uma segunda verdade que envelhece em silêncio: o backend muda um campo e
 * o app continua compilando, errado. Aqui o Dart **deriva** do Zod — se um schema muda,
 * a classe muda junto e o `flutter analyze` aponta onde.
 *
 * Mora neste pacote, e não em `app/`, por uma razão de resolução e uma de significado:
 * `app/` não é pacote do workspace pnpm e não alcança o `zod`; e quem sabe traduzir o
 * contrato é o pacote que o define.
 *
 *   pnpm --filter @petshop/shared-types run gen:dart
 *
 * O caminho é Zod 4 → JSON Schema (`z.toJSONSchema`, nativo) → quicktype → Dart.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import * as portal from '../src/portal.ts'

const SAIDA = join(import.meta.dirname, '.schemas')
const DOCUMENTO = join(SAIDA, 'portal.schema.json')
const DART = join(import.meta.dirname, '..', '..', '..', 'app', 'lib', 'src', 'models', 'portal_models.dart')

/**
 * Só o que o app **recebe** ou **envia como corpo**.
 *
 * Schema de query fica de fora de propósito: parâmetro de URL não vira classe, e vários
 * deles carregam `.transform()` que só existe em tempo de execução no servidor — o
 * `serviceIds` separado por vírgula, por exemplo, é string na rota e lista depois dela.
 */
const IGNORAR = /Query(Schema)?$/

interface Falha {
  nome: string
  motivo: string
}

function schemasDoPortal(): { nome: string; schema: z.ZodType }[] {
  const achados: { nome: string; schema: z.ZodType }[] = []
  for (const [chave, valor] of Object.entries(portal)) {
    if (!chave.endsWith('Schema')) continue
    if (IGNORAR.test(chave)) continue
    if (!(valor instanceof z.ZodType)) continue
    achados.push({ nome: chave.replace(/Schema$/, ''), schema: valor })
  }
  return achados.sort((a, b) => a.nome.localeCompare(b.nome))
}

/**
 * Saída primeiro, entrada como segunda tentativa.
 *
 * `io: 'output'` é o lado que o app vê num corpo de resposta: o que o servidor **já
 * aplicou**, com defaults preenchidos e coerções feitas. Mas um schema que existe só
 * para validar corpo de requisição pode carregar `.transform()`, e transformação não
 * tem representação do lado da saída — só do lado da entrada, que é justamente o lado
 * que o app precisa quando é ele quem manda o corpo.
 */
function converter(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>
  } catch {
    return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  }
}

/**
 * Um documento só, e não um arquivo por schema.
 *
 * O quicktype nomeia a classe pelo **arquivo de saída**, não pelo de entrada: gerado um
 * a um, `PortalSlot` sairia com o nome do `-o`. Reunidos sob `definitions`, com a raiz
 * apontando para cada um, os nomes saem certos e um tipo aninhado repetido vira uma
 * classe só em vez de várias com sufixo numérico.
 *
 * A classe da raiz nasce junto e não serve para nada — é o preço do arranjo.
 */
function montarDocumento(
  partes: { nome: string; json: Record<string, unknown> }[],
): Record<string, unknown> {
  const definitions: Record<string, unknown> = {}
  const properties: Record<string, unknown> = {}

  for (const { nome, json } of partes) {
    // O `$schema` de cada parte é da parte; quem o declara é o documento.
    const { $schema: _descartado, ...resto } = json
    definitions[nome] = resto
    properties[nome] = { $ref: `#/definitions/${nome}` }
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'PortalModels',
    type: 'object',
    properties,
    required: Object.keys(properties),
    definitions,
  }
}

/**
 * Reata as referências que o Zod desfez.
 *
 * `PortalAppointmentsResponse` é composto de `PortalAppointmentSchema` no TypeScript,
 * mas `toJSONSchema` **embute** a estrutura em vez de referenciá-la — o JSON Schema que
 * sai não sabe mais que aquele objeto tem nome. Sem isto o quicktype batiza cada cópia
 * pelo campo onde a encontrou, e o app acaba com `Upcoming`, `Past` e `PortalAppointment`
 * como três classes distintas para a mesma coisa.
 *
 * O reconhecimento é por igualdade estrutural exata, e é isso que o torna seguro:
 * `PortalUpcomingAppointment` estende `PortalAppointment` com mais um campo, então as
 * duas não se confundem — cada cópia casa com o nome de quem tem exatamente aquela forma.
 */
function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor)
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`
  const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(',')}}`
}

function reatarReferencias(documento: Record<string, unknown>): number {
  const definitions = documento.definitions as Record<string, unknown>

  /** Forma → nome. O primeiro nome vence, para a saída não depender da ordem do disco. */
  const porForma = new Map<string, string>()
  for (const [nome, corpo] of Object.entries(definitions)) {
    const chave = canonico(corpo)
    if (!porForma.has(chave)) porForma.set(chave, nome)
  }

  let trocas = 0

  const visitar = (no: unknown, raizDe: string | null): unknown => {
    if (no === null || typeof no !== 'object') return no
    if (Array.isArray(no)) return no.map((item) => visitar(item, null))

    // A própria definição não vira referência a si mesma.
    if (raizDe === null) {
      const nome = porForma.get(canonico(no))
      if (nome) {
        trocas += 1
        return { $ref: `#/definitions/${nome}` }
      }
    }

    const saida: Record<string, unknown> = {}
    for (const [chave, valor] of Object.entries(no as Record<string, unknown>)) {
      saida[chave] = visitar(valor, null)
    }
    return saida
  }

  for (const [nome, corpo] of Object.entries(definitions)) {
    definitions[nome] = visitar(corpo, nome)
  }
  return trocas
}

/**
 * O cabeçalho que o quicktype escreve é uma lista de 56 linhas de exemplo de uso. No
 * lugar dela vai o que quem abre o arquivo precisa saber: que ele é gerado, de onde, e
 * que editá-lo à mão é trabalho perdido na próxima geração.
 */
const CABECALHO = `// GERADO — não edite à mão.
//
// Origem: packages/shared-types/src/portal.ts (os schemas Zod do backend).
// Gerar de novo: pnpm --filter @petshop/shared-types run gen:dart
//
// Se um campo mudou no backend, ele muda aqui na próxima geração e o \`flutter analyze\`
// aponta cada lugar do app que precisava saber. É esse o motivo de o arquivo existir.

// As constantes de enum saem em MAIÚSCULAS porque é assim que o backend as escreve no
// JSON — \`CRITICAL\`, \`NO_ADDRESS\`, \`SERVICE_LIABILITY\`. Renomeá-las para o estilo do
// Dart afastaria o modelo do fio sem nada em troca.
// ignore_for_file: constant_identifier_names
`

function gerarDart(): void {
  const bruto = execFileSync(
    'npx',
    [
      '--yes',
      'quicktype@23',
      '--src-lang', 'schema',
      '--src', DOCUMENTO,
      '--lang', 'dart',
      '--final-props',
      '--no-copy-with',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )

  // Fora o cabeçalho de exemplos do quicktype: tudo até a primeira declaração.
  const corpo = bruto.slice(Math.max(0, bruto.search(/^(import|class|enum|final) /m)))
  writeFileSync(DART, CABECALHO + '\n' + corpo)

  const classes = (corpo.match(/^class /gm) ?? []).length
  console.log(`${classes} classes Dart em ${DART}`)
}

function main(): void {
  rmSync(SAIDA, { recursive: true, force: true })
  mkdirSync(SAIDA, { recursive: true })

  const falhas: Falha[] = []
  const partes: { nome: string; json: Record<string, unknown> }[] = []

  for (const { nome, schema } of schemasDoPortal()) {
    try {
      partes.push({ nome, json: converter(schema) })
    } catch (erro) {
      falhas.push({ nome, motivo: erro instanceof Error ? erro.message : String(erro) })
    }
  }

  const documento = montarDocumento(partes)
  const trocas = reatarReferencias(documento)
  writeFileSync(DOCUMENTO, JSON.stringify(documento, null, 2))
  console.log(`${partes.length} schemas reunidos em ${DOCUMENTO}`)
  console.log(`${trocas} estruturas embutidas reatadas ao schema que as nomeia`)

  gerarDart()

  if (falhas.length > 0) {
    console.log(`\n${falhas.length} fora (sem representação em JSON Schema):`)
    for (const f of falhas) console.log(`  ${f.nome}: ${f.motivo.split('\n')[0]}`)
  }
}

main()
