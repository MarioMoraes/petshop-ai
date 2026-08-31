'use server'

import { revalidatePath } from 'next/cache'
import { ApiError } from '@petshop/api-client'
import type {
  SiteContentPatch,
  SiteLead,
  SiteLeadPatch,
  SitePhoto,
  SitePhotoPatch,
  SiteSettings,
} from '@petshop/shared-types'
import { serverApi } from '@/lib/api'

/**
 * Ações do site (MOD-SITE-01, 03, 04 e 09).
 *
 * A recusa de publicar carrega `missing`, e não só uma frase: o serviço responde 422
 * listando o que falta — endereço, contato, serviço visível — e a tela precisa apontar
 * cada um. Dizer "dados incompletos" mandaria o admin caçar o campo pelas telas.
 */

export interface ActionFailure {
  ok: false
  message: string
  fieldErrors: Record<string, string>
  /** `ERR_SITE_001`: o que falta para o site poder ir ao ar. */
  missing?: string[]
}

export type ActionResult<T> = { ok: true; data: T } | ActionFailure

function toFailure(error: unknown): ActionFailure {
  if (error instanceof ApiError) {
    const extra = error.problem as ({ missing?: unknown } & Record<string, unknown>) | null
    return {
      ok: false,
      message: error.message,
      fieldErrors: error.fieldErrors,
      ...(Array.isArray(extra?.missing) ? { missing: extra.missing as string[] } : {}),
    }
  }
  return {
    ok: false,
    message: 'Não conseguimos falar com o servidor. Tente novamente em instantes.',
    fieldErrors: {},
  }
}

export async function updateSiteContentAction(
  patch: SiteContentPatch,
): Promise<ActionResult<SiteSettings>> {
  try {
    const data = await serverApi().updateSiteSettings(patch)
    revalidatePath('/site')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function publishSiteAction(): Promise<ActionResult<SiteSettings>> {
  try {
    const data = await serverApi().publishSite()
    revalidatePath('/site')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function unpublishSiteAction(): Promise<ActionResult<SiteSettings>> {
  try {
    const data = await serverApi().unpublishSite()
    revalidatePath('/site')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Galeria (MOD-SITE-04) ───────────────────────────────────────────────────

/**
 * O upload atravessa a Server Action como `FormData`.
 *
 * O teto de corpo da Server Action já está em 100 MB no `next.config.ts` — o padrão do
 * Next é 1 MB, e foi ele que recusou em silêncio toda foto de celular no álbum do pet.
 * Quem limita aqui é o `SITE_PHOTO_MAX_BYTES` de 8 MB, no parser do serviço.
 */
export async function uploadSitePhotoAction(form: FormData): Promise<ActionResult<SitePhoto>> {
  try {
    const data = await serverApi().uploadSitePhoto(form)
    revalidatePath('/site/galeria')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function updateSitePhotoAction(
  id: string,
  patch: SitePhotoPatch,
): Promise<ActionResult<SitePhoto>> {
  try {
    const data = await serverApi().updateSitePhoto(id, patch)
    revalidatePath('/site/galeria')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function deleteSitePhotoAction(id: string): Promise<ActionResult<null>> {
  try {
    await serverApi().deleteSitePhoto(id)
    revalidatePath('/site/galeria')
    return { ok: true, data: null }
  } catch (error) {
    return toFailure(error)
  }
}

// ─── Fila de contatos (MOD-SITE-09) ──────────────────────────────────────────

export async function updateSiteLeadAction(
  id: string,
  patch: SiteLeadPatch,
): Promise<ActionResult<SiteLead>> {
  try {
    const data = await serverApi().updateSiteLead(id, patch)
    revalidatePath('/site/contatos')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}

export async function convertSiteLeadAction(
  id: string,
  tutorId: string,
): Promise<ActionResult<SiteLead>> {
  try {
    const data = await serverApi().convertSiteLead(id, tutorId)
    revalidatePath('/site/contatos')
    return { ok: true, data }
  } catch (error) {
    return toFailure(error)
  }
}
