import { describe, expect, it } from 'vitest'
import { exigeEstabelecimento, isAdminPath, resolveHost, routeFor } from './host.js'

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
  it.each([
    '/dashboard',
    '/agenda',
    '/agenda/dia',
    '/tutores/123',
    '/sign-in',
    '/configuracoes',
    // O console da plataforma divide o host com o Admin: quem o esquecer nesta lista o
    // publica no subdomínio de todo estabelecimento.
    '/plataforma',
    '/plataforma/estabelecimentos',
  ])('%s é do Admin', (path) => {
    expect(isAdminPath(path)).toBe(true)
  })

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

describe('exigeEstabelecimento', () => {
  it.each([
    '/dashboard',
    '/tutores',
    '/tutores/123',
    '/pets/abc/editar',
    '/agenda/dia',
    '/mural',
    '/configuracoes',
    // Rota de arquivo também consulta a API com o tenant da sessão.
    '/financeiro/relatorios/pdf/contas-a-receber',
  ])('%s exige estabelecimento ativo', (path) => {
    expect(exigeEstabelecimento(path)).toBe(true)
  })

  it.each([
    // A raiz decide sozinha entre painel e wizard, sem consultar nada do tenant.
    '/',
    // Quem reativa a Organization não pode exigir que ela já esteja ativa.
    '/onboarding',
    '/convite/abc123',
    // O console da plataforma é o contrário: a sessão dele é a que não tem Organization.
    '/plataforma',
    '/plataforma/estabelecimentos',
    '/sign-in',
    '/sign-up/verify',
    // Fora do Admin a pergunta nem se aplica.
    '/portal/pets',
    '/api/health',
  ])('%s não exige', (path) => {
    expect(exigeEstabelecimento(path)).toBe(false)
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

  /** A raiz é do site do petshop, servida por reescrita para `/s/{slug}`. */
  it('a raiz é o site do petshop', () => {
    expect(routeFor(host, '/', DOMAIN)).toEqual({ action: 'site', slug: 'petshopdojoao' })
  })

  it('/portal passa; o gate é do MOD-PORTAL', () => {
    expect(routeFor(host, '/portal', DOMAIN)).toEqual({ action: 'portal' })
    expect(routeFor(host, '/portal/agendamentos', DOMAIN)).toEqual({ action: 'portal' })
  })

  it.each(['/dashboard', '/agenda/dia', '/tutores', '/configuracoes', '/plataforma'])(
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
   * para o site e o Next responde 404 lá dentro.
   */
  it('caminho desconhecido não vira 301 — vai ao site e o Next 404', () => {
    expect(routeFor(host, '/sobre', DOMAIN)).toEqual({ action: 'site', slug: 'petshopdojoao' })
    expect(routeFor(host, '/servicos/banho', DOMAIN)).toEqual({
      action: 'site',
      slug: 'petshopdojoao',
    })
  })

  /**
   * O caminho interno da página não é endereço de ninguém. Sem esta guarda,
   * `tenantA.{dominio}/s/tenantB` serviria o site do vizinho sob a URL errada — e
   * `app.{dominio}/s/qualquer` publicaria o site de quem tivesse o slug.
   */
  it.each([
    ['petshopdojoao.meupetshop.com.br', '/s/outro'],
    ['petshopdojoao.meupetshop.com.br', '/s/petshopdojoao'],
    ['app.meupetshop.com.br', '/s/petshopdojoao'],
    ['localhost:3002', '/s/qualquer'],
  ])('%s%s é 404: o caminho interno não é endereço', (h, path) => {
    expect(routeFor(h, path, DOMAIN)).toEqual({ action: 'notFound' })
  })

  it('o health check é público em qualquer host', () => {
    expect(routeFor(host, '/api/health', DOMAIN)).toEqual({ action: 'public' })
    expect(routeFor('app.meupetshop.com.br', '/api/health', DOMAIN)).toEqual({ action: 'public' })
  })

  /**
   * A revalidação chega pela rede interna, com `Host: frontend:3002` — que
   * `resolveHost` classifica como Admin. Sem a lista de sempre-públicos, o serviço
   * receberia um redirecionamento para a tela de login em vez de refazer a página.
   */
  it('a revalidação do site passa em qualquer host', () => {
    expect(routeFor('frontend:3002', '/api/site/revalidate', DOMAIN)).toEqual({
      action: 'public',
    })
    expect(routeFor(host, '/api/site/revalidate', DOMAIN)).toEqual({ action: 'public' })
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
