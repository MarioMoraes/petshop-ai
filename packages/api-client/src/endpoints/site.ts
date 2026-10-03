import {
  SiteLeadCountSchema,
  SiteLeadListSchema,
  SiteLeadSchema,
  SitePhotoSchema,
  SitePreviewSchema,
  SiteSettingsSchema,
  type SiteContentPatch,
  type SiteLeadPatch,
  type SiteLeadStatus,
  type SitePhotoPatch,
} from '@petshop/shared-types'
import { z } from 'zod'
import { type Transport } from '../transport.js'

export function siteEndpoints({ request, upload }: Transport) {
  return {
    // ─── MOD-SITE — o site do estabelecimento ──────────────────────────────

    getSiteSettings: () =>
      request({ method: 'GET', path: '/v1/site/settings', schema: SiteSettingsSchema }),

    updateSiteSettings: (patch: SiteContentPatch) =>
      request({
        method: 'PATCH',
        path: '/v1/site/settings',
        body: patch,
        schema: SiteSettingsSchema,
      }),

    publishSite: () =>
      request({ method: 'POST', path: '/v1/site/publish', schema: SiteSettingsSchema }),

    unpublishSite: () =>
      request({ method: 'POST', path: '/v1/site/unpublish', schema: SiteSettingsSchema }),

    /** A página montada mesmo despublicada, mais o que falta para publicar. */
    getSitePreview: () =>
      request({ method: 'GET', path: '/v1/site/preview', schema: SitePreviewSchema }),

    listSitePhotos: () =>
      request({
        method: 'GET',
        path: '/v1/site/photos',
        schema: z.object({ items: z.array(SitePhotoSchema) }),
      }),

    uploadSitePhoto: (form: FormData) => upload('/v1/site/photos', form, SitePhotoSchema),

    updateSitePhoto: (id: string, patch: SitePhotoPatch) =>
      request({
        method: 'PATCH',
        path: `/v1/site/photos/${id}`,
        body: patch,
        schema: SitePhotoSchema,
      }),

    deleteSitePhoto: (id: string) =>
      request<void>({ method: 'DELETE', path: `/v1/site/photos/${id}` }),

    /**
     * Só o contador da fila, para o sino de pendências. Não decifra nada — ver
     * `SiteLeadCountSchema`.
     */
    countSiteLeads: () =>
      request({
        method: 'GET',
        path: '/v1/site/leads/count',
        schema: SiteLeadCountSchema,
      }),

    listSiteLeads: (status?: SiteLeadStatus) =>
      request({
        method: 'GET',
        path: status ? `/v1/site/leads?status=${status}` : '/v1/site/leads',
        schema: SiteLeadListSchema,
      }),

    updateSiteLead: (id: string, patch: SiteLeadPatch) =>
      request({
        method: 'PATCH',
        path: `/v1/site/leads/${id}`,
        body: patch,
        schema: SiteLeadSchema,
      }),

    /** Exige `tutor:create` além de `site:read_leads`: a ficha é criada pelo MOD-TUTOR. */
    convertSiteLead: (id: string, tutorId: string) =>
      request({
        method: 'POST',
        path: `/v1/site/leads/${id}/convert`,
        body: { tutorId },
        schema: SiteLeadSchema,
      }),
  }
}
