import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as sharedTypes from '@petshop/shared-types'

/**
 * Os enums do Prisma não podem divergir dos `z.enum` que os espelham.
 *
 * **O defeito que motivou este arquivo.** A migration `20260916120000_mod_ai_origem`
 * acrescentou `AGENT_HANDOFF` ao tipo `MessageOriginType` do Postgres, e nem
 * `schema.prisma` nem `MessageOriginTypeSchema` receberam o valor. O banco aceitava, o
 * Zod recusava — e como o Zod roda primeiro, **toda resposta do agente de WhatsApp
 * falhava na validação**, depois de o turno já ter sido pago ao provedor do modelo. O
 * sintoma no log era um `ZodError` em `messaging-port.ts`, a três módulos de distância
 * de quem esqueceu a linha.
 *
 * Nada pegava isso. A suíte do MOD-AI dubla a `AgentMessagingPort`, então o schema real
 * nunca era exercitado com o valor novo; o typecheck não ajuda porque o literal é uma
 * string que o Zod só confere em tempo de execução.
 *
 * O pareamento é **por convenção de nome**: o enum `Foo` do Prisma casa com o export
 * `FooSchema` de `@petshop/shared-types`. Enum sem par é ignorado de propósito — muitos
 * são só do banco e não têm contrato de API. O que este teste garante é que, **havendo
 * par, os dois lados têm exatamente os mesmos valores**.
 *
 * Estático de propósito, como `rls-models-sync`: lê arquivo, não abre conexão.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = join(packageRoot, 'prisma', 'schema.prisma')

/** `enum Nome { A B C }` do schema, já sem comentários `///` e sem chaves. */
function lerEnumsDoPrisma(): Map<string, string[]> {
  const fonte = readFileSync(schemaPath, 'utf8')
  const enums = new Map<string, string[]>()

  for (const bloco of fonte.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const nome = bloco[1]
    const corpo = bloco[2]
    if (!nome || !corpo) continue

    const valores = corpo
      .split('\n')
      .map((linha) => linha.trim())
      .filter((linha) => linha.length > 0 && !linha.startsWith('//'))
      .map((linha) => linha.split(/\s+/)[0])
      .filter((valor): valor is string => Boolean(valor))

    enums.set(nome, valores)
  }

  return enums
}

/** As opções de um `z.enum`, ou `null` se o export não for um. */
function opcoesDoZod(valor: unknown): string[] | null {
  if (!valor || typeof valor !== 'object') return null
  const options = (valor as { options?: unknown }).options
  if (!Array.isArray(options)) return null
  return options.every((opcao) => typeof opcao === 'string') ? (options as string[]) : null
}

const enumsDoPrisma = lerEnumsDoPrisma()

const pares = [...enumsDoPrisma].flatMap(([nome, valores]) => {
  const opcoes = opcoesDoZod((sharedTypes as Record<string, unknown>)[`${nome}Schema`])
  return opcoes ? [{ nome, valores, opcoes }] : []
})

describe('enums do Prisma × schemas do Zod', () => {
  it('encontra os pares pela convenção de nome', () => {
    // Se a convenção mudar, ou o barril parar de reexportar, o teste passaria vazio e
    // não guardaria nada. O piso é arbitrário, mas cai só quando algo estrutural quebra.
    expect(enumsDoPrisma.size).toBeGreaterThan(20)
    expect(pares.length).toBeGreaterThan(5)
  })

  it.each(pares)('$nome tem os mesmos valores dos dois lados', ({ valores, opcoes }) => {
    expect([...opcoes].sort()).toEqual([...valores].sort())
  })

  /**
   * O caso concreto, escrito à mão além da varredura: ele é o motivo do arquivo, e um
   * teste nomeado diz na falha o que a varredura genérica só insinuaria.
   */
  it('MessageOriginType aceita a origem da resposta do agente (MOD-AI-06)', () => {
    expect(enumsDoPrisma.get('MessageOriginType')).toContain('AGENT_HANDOFF')
    expect(sharedTypes.MessageOriginTypeSchema.safeParse('AGENT_HANDOFF').success).toBe(true)
  })
})
