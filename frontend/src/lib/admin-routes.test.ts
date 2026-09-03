import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADMIN_ROUTE_PREFIXES, PORTAL_PREFIX, SITE_PREFIX } from './host.js'

/**
 * A guarda do roteamento por host.
 *
 * `ADMIN_ROUTE_PREFIXES` decide o que sai do host do tenant com 301. Uma tela nova em
 * `src/app` que não entre nessa lista **fica pública no host de todo tenant** — sem
 * erro, sem log, sem nada que apareça em produção até alguém tropeçar nela.
 *
 * Este teste compara a lista com o disco. Se ele falhar depois de você criar uma tela,
 * a pergunta a responder é: essa rota é do Admin (entra em `ADMIN_ROUTE_PREFIXES`) ou é
 * do público (entra em `TENANT_SURFACE`)?
 */

/**
 * O `app/` tem **três** raízes, cada um com o próprio `<html>` e um público:
 * `(admin)`, a equipe; `(site)`, o visitante anônimo; `(portal)`, o cliente do petshop.
 * O grupo não vira segmento de URL — `(admin)/dashboard` continua sendo `/dashboard` —,
 * então a varredura precisa olhar dentro dos três.
 */
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../app')
const ROOT_GROUPS = ['(admin)', '(site)', '(portal)']

/**
 * Rotas que **devem** responder no host do tenant, e por isso não são do Admin.
 *
 * `s` é onde o site do petshop mora de verdade: o visitante nunca digita esse
 * caminho — o middleware reescreve `{slug}.{dominio}/` para `/s/{slug}` —, e pedi-lo
 * direto é 404 por decisão de `routeFor`.
 */
const TENANT_SURFACE = new Set([PORTAL_PREFIX.slice(1), SITE_PREFIX.slice(1)])

function routeDirectories(): string[] {
  const dirs = [appDir, ...ROOT_GROUPS.map((group) => join(appDir, group))]

  return dirs.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // `_pasta` e `(grupo)` não viram segmento de URL.
      .filter((entry) => !entry.name.startsWith('_') && !entry.name.startsWith('('))
      // `@slot` é rota paralela, não caminho próprio.
      .filter((entry) => !entry.name.startsWith('@'))
      .map((entry) => entry.name),
  )
}

describe('cobertura das rotas', () => {
  it('toda pasta de src/app está classificada como Admin ou como superfície do tenant', () => {
    const declared = new Set([
      ...ADMIN_ROUTE_PREFIXES.map((prefix) => prefix.slice(1)),
      ...TENANT_SURFACE,
      // `api/` não é tela: as rotas de API têm o próprio tratamento no middleware.
      'api',
    ])

    const unclassified = routeDirectories().filter((name) => !declared.has(name))

    expect(unclassified, `rotas sem classificação em host.ts: ${unclassified.join(', ')}`).toEqual(
      [],
    )
  })

  it('não lista rota do Admin que não existe mais', () => {
    const onDisk = new Set(routeDirectories())
    const stale = ADMIN_ROUTE_PREFIXES.map((prefix) => prefix.slice(1)).filter(
      (name) => !onDisk.has(name),
    )

    expect(stale, `prefixos do Admin sem pasta correspondente: ${stale.join(', ')}`).toEqual([])
  })
})
