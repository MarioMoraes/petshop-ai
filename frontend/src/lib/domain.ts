import 'server-only'

/**
 * Domínio da instalação, lido em tempo de execução.
 *
 * Pelo mesmo motivo do `API_URL` em `api.ts`: **não** é `NEXT_PUBLIC_`. O prefixo
 * público faria o Next inlinear o valor no build, e a imagem nasceria amarrada a um
 * ambiente. Aqui o valor é resolvido no servidor e desce como prop para as telas que
 * precisam mostrá-lo.
 *
 * Até 2026-08-28 o sufixo `.petshopai.app` estava cravado no onboarding e nas
 * configurações, enquanto `APP_DOMAIN` em produção é outro — o admin escolhia o slug
 * lendo um endereço que não existiria.
 */
const APP_DOMAIN = process.env.APP_DOMAIN ?? 'localhost:3002'

/** O domínio da instalação, para quem precisa resolver o host em vez de exibi-lo. */
export function appDomain(): string {
  return APP_DOMAIN
}

/** `petshopdojoao.meupetshop.com.br` — o endereço do tenant, decisão de 2026-08-28. */
export function tenantHost(slug: string): string {
  return `${slug}.${APP_DOMAIN}`
}

/** O sufixo exibido ao lado do campo de slug. */
export function tenantHostSuffix(): string {
  return `.${APP_DOMAIN}`
}

/**
 * Onde o tutor entra.
 *
 * O site público do estabelecimento fica na **raiz** do host do tenant (SEO local não
 * compete bem em subpasta) e o Portal do Tutor em `/portal`, sob a mesma origem — são
 * o mesmo público, e o "Agendar" do site cai no Portal sem salto entre domínios.
 * O Admin da equipe vive em `app.{dominio}`, host à parte: o site público é a
 * superfície mais exposta do sistema, e o cookie de sessão de quem opera o petshop não
 * tem por que dividir origem com ela.
 */
export function portalUrl(slug: string): string {
  return `https://${tenantHost(slug)}/portal`
}
