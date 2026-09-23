import { describe, expect, it } from 'vitest'
import { MESSAGE_TEMPLATES, extractVariables } from './messaging-seed.js'

/**
 * O catálogo de textos não pode declarar uma variável que o substituidor não enxerga.
 *
 * **O defeito que motivou este arquivo.** O template `agent_reply` nasceu com
 * `{{mensagem}}`, sem namespace. A expressão do substituidor
 * (`messaging/render.ts`) exige `{{namespace.campo}}` — com o ponto —, então o
 * marcador nunca casava e o cliente recebia no WhatsApp o texto `{{mensagem}}`
 * literal no lugar da resposta do agente.
 *
 * **Nada falhava.** A mensagem era montada, enfileirada, enviada e entregue. Não havia
 * exceção, log de erro nem variável faltando: `render` só registra em `missing` o que
 * ele reconhece como marcador, e este ele não reconhecia. O único lugar onde o defeito
 * aparecia era a tela do celular de quem escreveu para o petshop.
 *
 * A suíte do MOD-AI não pegava porque ela dubla a porta de mensagens, então o
 * `render` real nunca rodava com este template.
 */

/** Permissiva de propósito: pega **qualquer** `{{...}}`, inclusive o que o render ignora. */
const QUALQUER_MARCADOR = /\{\{([^}]*)\}\}/g

function marcadores(texto: string): string[] {
  return [...texto.matchAll(QUALQUER_MARCADOR)].map((match) => (match[1] ?? '').trim())
}

const textos = MESSAGE_TEMPLATES.flatMap((template) => [
  ...(template.subject ? [{ key: template.key, onde: 'subject', texto: template.subject }] : []),
  ...Object.entries(template.body).map(([canal, corpo]) => ({
    key: template.key,
    onde: canal,
    texto: corpo as string,
  })),
  // O texto do push passa pelo mesmo `render`, e um marcador errado ali apareceria na
  // tela bloqueada do tutor do mesmo jeito que `{{mensagem}}` apareceu no WhatsApp.
  ...(template.push
    ? [
        { key: template.key, onde: 'push.title', texto: template.push.title },
        { key: template.key, onde: 'push.body', texto: template.push.body },
      ]
    : []),
])

describe('marcadores dos textos semeados', () => {
  it('encontra o catálogo inteiro', () => {
    expect(MESSAGE_TEMPLATES.length).toBeGreaterThan(5)
    expect(textos.length).toBeGreaterThan(MESSAGE_TEMPLATES.length)
  })

  /**
   * A asserção que teria custado zero e evitou nada: todo `{{...}}` escrito no texto
   * precisa ser um marcador que o substituidor reconhece.
   */
  it.each(textos)('$key · $onde — todo marcador tem namespace', ({ texto }) => {
    const escritos = marcadores(texto)
    const reconhecidos = new Set(extractVariables(texto))
    const invisiveis = escritos.filter((nome) => !reconhecidos.has(nome))

    expect(invisiveis).toEqual([])
  })

  it.each(textos)('$key · $onde — todo marcador está declarado', ({ key, texto }) => {
    const template = MESSAGE_TEMPLATES.find((item) => item.key === key)
    const declaradas = new Set<string>(template?.variables ?? [])
    const naoDeclaradas = extractVariables(texto).filter((nome) => !declaradas.has(nome))

    expect(naoDeclaradas).toEqual([])
  })
})

describe('variáveis declaradas', () => {
  /**
   * A outra ponta do mesmo defeito: uma variável declarada sem ponto é uma que o texto
   * nunca vai conseguir usar, e quem a escrever no corpo cairá no caso acima.
   */
  it.each(MESSAGE_TEMPLATES.map((t) => ({ key: t.key, variables: t.variables })))(
    '$key — nenhuma variável declarada sem namespace',
    ({ variables }) => {
      const semPonto = variables.filter((nome) => !nome.includes('.'))
      expect(semPonto).toEqual([])
    },
  )
})

/**
 * O que chega à tela bloqueada (etapa 9 do app).
 *
 * O push é lido por qualquer um que esteja ao lado do celular, sem desbloquear. Três
 * regras que nenhum outro teste percebe e que um template novo copiado de outro pode
 * quebrar sem ninguém notar.
 */
describe('texto de push', () => {
  const comPush = MESSAGE_TEMPLATES.filter((template) => template.push)

  it('existe nos avisos escolhidos, e só neles', () => {
    expect(comPush.map((template) => template.key).sort()).toEqual(
      [
        'appointment_cancelled',
        'appointment_confirmed',
        'appointment_reminder',
        'dunning_final',
        'dunning_firm',
        'dunning_soft',
        'service_done',
        'taxi_arrived',
        'taxi_delivered',
        'taxi_en_route',
        'taxi_failed',
      ].sort(),
    )
  })

  it('nunca é de marketing, de equipe nem de código de acesso', () => {
    for (const template of comPush) {
      expect(template.category, template.key).not.toBe('MARKETING')
      expect(template.audience ?? 'TUTOR', template.key).toBe('TUTOR')
      expect(template.key, template.key).not.toMatch(/codigo/)
    }
  })

  it('não diz valor de dinheiro na tela bloqueada', () => {
    for (const template of comPush) {
      const texto = `${template.push!.title} ${template.push!.body}`
      expect(texto, template.key).not.toMatch(/financeiro\.|R\$/)
    }
  })

  it('cabe na notificação sem ser cortado', () => {
    for (const template of comPush) {
      expect(template.push!.title.length, template.key).toBeLessThanOrEqual(50)
      expect(template.push!.body.length, template.key).toBeLessThanOrEqual(120)
    }
  })
})
