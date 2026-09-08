import { loadEnv } from '../../config/env.js'

/**
 * A URL canônica do tenant, montada do domínio da instalação e não da requisição.
 *
 * Sai daqui, e não do `Host` recebido, porque o `Host` de uma chamada interna do Next
 * é `tenant-site-service:3013` — e um `canonical` apontando para o nome de container
 * é um `canonical` que tira a página do índice.
 */
export function canonicalUrlOf(slug: string): string {
  const domain = loadEnv().APP_DOMAIN
  const protocol = domain.startsWith('localhost') ? 'http' : 'https'
  return `${protocol}://${slug}.${domain}`
}
