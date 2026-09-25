import { givenTenant as givenInventoryTenant, type TenantFixture } from '../inventory/fixtures.js'

/**
 * Cenário do MOD-CAIXA.
 *
 * O caixa vive do estoque (a venda avulsa) e do razão (o pagamento do tutor), e o
 * cenário é o do estoque — um estabelecimento Pro com fuso, um tutor para cobrar, a
 * chave do duplo clique — **mais a chave de cifra do tenant**: o pagamento lido de volta
 * decifra a observação, e todo estabelecimento de verdade nasce com ela.
 */
export * from '../inventory/fixtures.js'

export async function givenTenant(
  ...args: Parameters<typeof givenInventoryTenant>
): Promise<TenantFixture> {
  const fixture = await givenInventoryTenant(...args)
  const { createTenantKey, withTenant } = await import('@petshop/db')
  await withTenant(fixture.tenantId, (tx) => createTenantKey(tx, fixture.tenantId))
  return fixture
}
