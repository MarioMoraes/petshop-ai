import { withTenant, type TenantTransaction } from '@petshop/db'
import { resolveZipZone, type TaxiPriceSource, type TaxiSettings } from '@petshop/shared-types'
import { outsideZones } from './errors.js'
import { assertEnabled } from './settings.js'
import { readZones } from './zones.js'

/**
 * Preço de uma perna (MOD-TAXI-05 e 06).
 *
 * A ordem é: preço manual, zona, padrão do tenant. Nenhuma interpolação por
 * distância, nenhuma média entre zonas vizinhas — o mesmo princípio do RN-03 da
 * agenda, e pelo mesmo motivo: valor inventado vira discussão no balcão.
 */

export interface ResolvedPrice {
  priceCents: number
  source: TaxiPriceSource
  zoneId: string | null
  zoneName: string | null
}

export async function resolvePrice(
  tx: TenantTransaction,
  settings: TaxiSettings,
  zipCode: string,
  override?: number | undefined,
): Promise<ResolvedPrice> {
  if (override !== undefined) {
    return { priceCents: override, source: 'MANUAL', zoneId: null, zoneName: null }
  }

  const zones = await readZones(tx, { activeOnly: true })
  const zone = resolveZipZone(zipCode, zones)

  if (zone) {
    return {
      priceCents: zone.priceCents,
      source: 'ZONE',
      zoneId: zone.id,
      zoneName: zone.name,
    }
  }

  // RN-18: recusar o CEP é opt-in. O petshop que não atende a cidade inteira liga
  // `block_outside_zones`; o que atende de tudo usa o preço padrão e segue.
  if (settings.blockOutsideZones) {
    throw outsideZones(`O CEP ${zipCode} está fora das zonas atendidas`, { zipCode })
  }

  return {
    priceCents: settings.defaultPriceCents,
    source: 'DEFAULT',
    zoneId: null,
    zoneName: null,
  }
}

/**
 * A cotação de um CEP, do começo ao fim.
 *
 * Estava inline no handler de `GET /v1/taxi/quote`. Saiu de lá na fatia 11, quando o
 * Portal passou a precisar da mesma resposta sem passar por HTTP — e o que motivou a
 * extração é o de sempre: duas cópias da mesma sequência divergem no dia em que uma
 * delas ganhar uma regra.
 *
 * `assertEnabled` vem antes do preço de propósito: um tenant com o Taxi Dog desligado
 * não tem cotação a dar, e devolver um número seria oferecer um serviço que não existe.
 */
export interface TaxiQuoteResult {
  zipCode: string
  priceCents: number
  priceSource: TaxiPriceSource
  zone: { id: string; name: string } | null
}

export async function quoteZipCode(
  tenantId: string,
  zipCode: string,
): Promise<TaxiQuoteResult> {
  return withTenant(tenantId, async (tx) => {
    const settings = await assertEnabled(tx, tenantId)
    const price = await resolvePrice(tx, settings, zipCode)
    return {
      zipCode,
      priceCents: price.priceCents,
      priceSource: price.source,
      zone: price.zoneId ? { id: price.zoneId, name: price.zoneName ?? '' } : null,
    }
  })
}
