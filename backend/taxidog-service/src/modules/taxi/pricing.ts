import type { TenantTransaction } from '@petshop/db'
import { resolveZipZone, type TaxiPriceSource, type TaxiSettings } from '@petshop/shared-types'
import { outsideZones } from '../../lib/errors.js'
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
