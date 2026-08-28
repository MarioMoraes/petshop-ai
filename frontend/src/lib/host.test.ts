import { describe, expect, it } from 'vitest'
import { isAdminPath, resolveHost, routeFor } from './host.js'

/** Roteamento por host (MOD-SITE-11). */

const DOMAIN = 'meupetshop.com.br'

describe('resolveHost', () => {
  it('reconhece o host de um tenant', () => {
    expect(resolveHost('petshopdojoao.meupetshop.com.br', DOMAIN)).toEqual({
      kind: 'tenant',
      slug: 'petshopdojoao',
    })
  })

  it('o ápice é da plataforma, não de um tenant', () => {
    expect(resolveHost(DOMAIN, DOMAIN).kind).toBe('admin')
  })

  it('`app` é o Admin', () => {
    expect(resolveHost('app.meupetshop.com.br', DOMAIN).kind).toBe('admin')
  })

  it.each(['api', 'www', 'portal', 'admin', 'cdn'])('o slug reservado %s não é tenant', (sub) => {
    expect(resolveHost(`${sub}.${DOMAIN}`, DOMAIN).kind).toBe('admin')
  })

  it('sub-subdomínio não é tenant — slug não tem ponto', () => {
    expect(resolveHost('a.b.meupetshop.com.br', DOMAIN).kind).toBe('admin')
  })

  /**
   * Falhar fechado. Um domínio apontado para este servidor por engano encontra a
   * superfície que exige sessão, não a que serve conteúdo.
   */
  it.each(['exemplo.com', 'meupetshop.com.br.evil.com', '', 'localhost:3002'])(
    'host desconhecido (%s) cai no Admin',
    (host) => {
      expect(resolveHost(host, DOMAIN).kind).toBe('admin')
    },
  )

  it('é insensível a maiúsculas', () => {
    expect(resolveHost('PetshopDoJoao.MeuPetshop.com.br', DOMAIN)).toEqual({
      kind: 'tenant',
      slug: 'petshopdojoao',
    })
  })

  /** Em desenvolvimento não há subdomínio: tudo continua sendo o Admin. */
  it('desenvolvimento em localhost não muda de comportamento', () => {
    expect(resolveHost('localhost:3002', 'localhost:3002').kind).toBe('admin')
  })
})

describe('isAdminPath', () => {
  it.each(['/dashboard', '/agenda', '/agenda/dia', '/tutores/123', '/sign-in', '/configuracoes'])(
    '%s é do Admin',
    (path) => {
      expect(isAdminPath(path)).toBe(true)
    },
  )

  it.each(['/', '/sobre', '/portal', '/portal/pets', '/agendamento-online'])(
    '%s não é do Admin',
    (path) => {
      expect(isAdminPath(path)).toBe(false)
    },
  )

  /** Prefixo é segmento inteiro: `/petsitting` não é `/pets`. */
  it('não casa prefixo pela metade', () => {
    expect(isAdminPath('/petsitting')).toBe(false)
    expect(isAdminPath('/agendamentos')).toBe(false)
  })
})

describe('routeFor — host do Admin', () => {
  it('segue o fluxo de sempre', () => {
    expect(routeFor('app.meupetshop.com.br', '/dashboard', DOMAIN)).toEqual({ action: 'admin' })
    expect(routeFor('app.meupetshop.com.br', '/sign-in', DOMAIN)).toEqual({ action: 'admin' })
    expect(routeFor('localhost:3002', '/agenda/dia', 'localhost:3002')).toEqual({ action: 'admin' })
  })
})

describe('routeFor — host do tenant', () => {
  const host = 'petshopdojoao.meupetshop.com.br'

  /**
   * A raiz troca de dono quando o MOD-SITE existir. Até lá vai ao Admin, e o **307**
   * é a parte que importa: um 301 ficaria no cache do browser e mandaria o visitante
   * ao Admin mesmo depois de o site nascer.
   */
  it('a raiz vai ao Admin com 307, não 301 — ela ainda vai virar o site', () => {
    expect(routeFor(host, '/', DOMAIN)).toEqual({
      action: 'redirect',
      host: 'app.meupetshop.com.br',
      permanent: false,
    })
  })

  it('/portal passa; o gate é do MOD-PORTAL', () => {
    expect(routeFor(host, '/portal', DOMAIN)).toEqual({ action: 'portal' })
    expect(routeFor(host, '/portal/agendamentos', DOMAIN)).toEqual({ action: 'portal' })
  })

  it.each(['/dashboard', '/agenda/dia', '/tutores', '/configuracoes'])(
    '%s foi para o host do Admin, com 301',
    (path) => {
      expect(routeFor(host, path, DOMAIN)).toEqual({
        action: 'redirect',
        host: 'app.meupetshop.com.br',
        permanent: true,
      })
    },
  )

  /**
   * 301 fica no cache do browser. Amarrar uma futura página do site a um destino
   * errado seria irreversível para quem já o guardou — por isso o desconhecido segue
   * como público e o Next responde 404.
   */
  it('caminho desconhecido não vira 301 — segue público e o Next 404', () => {
    expect(routeFor(host, '/sobre', DOMAIN)).toEqual({ action: 'public' })
    expect(routeFor(host, '/servicos/banho', DOMAIN)).toEqual({ action: 'public' })
  })

  it('o health check é público em qualquer host', () => {
    expect(routeFor(host, '/api/health', DOMAIN)).toEqual({ action: 'public' })
    expect(routeFor('app.meupetshop.com.br', '/api/health', DOMAIN)).toEqual({ action: 'public' })
  })
})

/**
 * O `APP_DOMAIN` não precisa ser um domínio de segundo nível. Instalar sob
 * `petshop.officestecnologia.com.br` — um domínio já usado para outra coisa — é
 * legítimo, e o corte por sufixo funciona igual: o que separa o slug do domínio é a
 * primeira label, não a contagem de pontos.
 *
 * O que muda fora daqui é a borda: o wildcard do Caddy vira
 * `*.petshop.officestecnologia.com.br`, que é de **dois** níveis para a zona
 * `officestecnologia.com.br` — o Universal SSL da Cloudflare não cobre isso, então o
 * registro precisa ficar em DNS-only. Ver `infra/README.md`.
 */
describe('routeFor — APP_DOMAIN com mais de duas labels', () => {
  const domain = 'petshop.officestecnologia.com.br'
  const host = `petshopdojoao.${domain}`

  it('a primeira label continua sendo o slug', () => {
    expect(resolveHost(host, domain)).toEqual({ kind: 'tenant', slug: 'petshopdojoao' })
  })

  it('o ápice da instalação é da plataforma', () => {
    expect(resolveHost(domain, domain).kind).toBe('admin')
    expect(resolveHost(`app.${domain}`, domain).kind).toBe('admin')
  })

  /**
   * O domínio guarda-chuva não é a instalação: `petshopdojoao.officestecnologia.com.br`
   * é outro host, e cai fechado no Admin como qualquer desconhecido.
   */
  it('o domínio de cima não é a instalação', () => {
    expect(resolveHost('petshopdojoao.officestecnologia.com.br', domain).kind).toBe('admin')
    expect(resolveHost('officestecnologia.com.br', domain).kind).toBe('admin')
  })

  it('as rotas do Admin vão para app. do domínio inteiro', () => {
    expect(routeFor(host, '/dashboard', domain)).toEqual({
      action: 'redirect',
      host: `app.${domain}`,
      permanent: true,
    })
  })
})
