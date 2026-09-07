import type { TenantTransaction } from '@petshop/db'
import type { DocumentAddress, DocumentIssuer } from './layout.js'

/**
 * Quem emitiu o documento, lido do banco.
 *
 * Nasceu dentro do `receipts.ts` do MOD-LEDGER e sobe para cá na fatia 2 do MOD-DOC,
 * quando o receituário virou o **segundo** chamador: o cabeçalho é o mesmo em todo
 * documento, e a montagem dele também. É a decisão 9 do projeto — extrai-se no segundo
 * serviço, não antes.
 *
 * Devolve o fuso junto porque quem imprime precisa dos dois e eles saem da mesma linha:
 * duas consultas ao `tenant_settings` para montar um cabeçalho seriam uma a mais.
 */

interface BrandingJson {
  logoUrl?: string | null
  primaryColor?: string | null
}

export interface DocumentIssuerContext {
  issuer: DocumentIssuer
  timezone: string
}

export async function loadIssuer(
  tx: TenantTransaction,
  tenantId: string,
): Promise<DocumentIssuerContext> {
  const [tenant, settings] = await Promise.all([
    tx.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { name: true, legalName: true },
    }),
    tx.tenantSettings.findUnique({
      where: { tenantId },
      select: {
        timezone: true,
        addressZip: true,
        addressStreet: true,
        addressNumber: true,
        addressComplement: true,
        addressDistrict: true,
        addressCity: true,
        addressState: true,
        publicPhone: true,
        branding: true,
      },
    }),
  ])

  const branding = (settings?.branding ?? {}) as BrandingJson

  // O CHECK `tenant_settings_address_complete` garante tudo ou nada; a checagem de um
  // campo bastaria, e o resto do `&&` é o que convence o TypeScript.
  const address: DocumentAddress | null =
    settings?.addressStreet &&
    settings.addressZip &&
    settings.addressNumber &&
    settings.addressDistrict &&
    settings.addressCity &&
    settings.addressState
      ? {
          zip: settings.addressZip,
          street: settings.addressStreet,
          number: settings.addressNumber,
          complement: settings.addressComplement,
          district: settings.addressDistrict,
          city: settings.addressCity,
          state: settings.addressState,
        }
      : null

  return {
    issuer: {
      name: tenant.name,
      legalName: tenant.legalName,
      // O CNPJ fica de fora por ora: `tenants.cnpj_encrypted` exige a DEK do tenant, e
      // nenhum documento emitido até aqui o mostrou. Entra junto com a discussão de
      // NFS-e (questão 2 do §11).
      cnpj: null,
      address,
      phone: settings?.publicPhone ?? null,
      logoUrl: branding.logoUrl ?? null,
      primaryColor: branding.primaryColor ?? null,
    },
    // O endereço **não é cifrado** — é comercial, e o MOD-SITE existe para publicá-lo.
    // O do tutor continua cifrado porque é residencial.
    timezone: settings?.timezone ?? 'America/Sao_Paulo',
  }
}
