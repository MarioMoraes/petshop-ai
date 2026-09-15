/**
 * A Organization ativa do token, venha ele do JWT template ou do token de sessão padrão.
 *
 * **Os dois formatos chegam aqui, e não por escolha.** O frontend pede o template
 * `petshop`, que publica `org_id` no topo do payload (`docs/setup-clerk.md` §3). Quando
 * essa emissão falha — e em 2026-09-15 ela falhava em produção, com a instância de
 * desenvolvimento do Clerk recusando rajadas de pedidos —, o frontend segue com o token de
 * sessão padrão. Esse, na versão 2 do Clerk, guarda a Organization em `o.id`, e não em
 * `org_id`.
 *
 * Ler só `org_id` transformava cada uma dessas quedas num usuário **com** estabelecimento
 * ativo sendo recusado com "Selecione um estabelecimento para continuar" — o 403 que
 * derrubava tutores e pets com "Application error" e sumia sozinho um minuto depois.
 *
 * Ler `o.id` não alarga quem entra: o token padrão já era aceito, verificado pela mesma
 * assinatura e pelo mesmo `authorizedParties`. O que muda é só ele deixar de perder o
 * estabelecimento pelo caminho.
 */
export function readOrgId(payload: Record<string, unknown>): string | null {
  if (typeof payload.org_id === 'string' && payload.org_id.length > 0) return payload.org_id

  const org = payload.o
  if (org && typeof org === 'object' && 'id' in org) {
    const id = (org as { id: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }

  return null
}
