import { z } from 'zod'
import { BrandingSchema, BusinessHoursSchema, TenantAddressSchema } from './identity.js'
import { normalizePhoneBR, InvalidPhoneError } from './br-documents.js'

/**
 * MOD-SITE — o site do estabelecimento (PRD site_tenant_10 §4 e §5).
 *
 * Duas decisões de produto estão codificadas aqui e valem ser lidas antes do resto:
 *
 * **1. Template fixo alimentado pelos dados, sem editor de blocos.** A página nasce
 * montada do que o tenant já cadastrou — nome, logo, cores, endereço, telefone,
 * horário, serviços — e o admin edita **quatro** textos livres. Um petshop de cinco
 * pessoas não vai "montar uma página", e um editor de blocos entregue a quem não é
 * designer produz um site pior que o template.
 *
 * **2. Preço público é piso, nunca exato.** `MIN(service_pricing.price_cents)`
 * rotulado "a partir de": o site não sabe qual é o pet, a tabela completa entrega a
 * grade ao concorrente, e nenhum preço mantém no telefone a pergunta que o site
 * deveria responder (RN-04).
 */

// ─── Conteúdo ────────────────────────────────────────────────────────────────

/**
 * Os campos do conteúdo do site, **sem `.default()`**.
 *
 * A separação entre este objeto e `SiteSettingsSchema` é a mesma de
 * `TenantSettingsFields`, e existe pelo mesmo motivo: `.partial()` no Zod **não**
 * remove `.default()`. Um PATCH parcial montado a partir do schema com defaults
 * grava `showPrices: true` por cima do `false` que o tenant escolheu, sem que o campo
 * tenha sido enviado.
 */
export const SiteContentFields = {
  /** A chamada. Vazia, a página deriva do nome do estabelecimento. */
  headline: z.string().trim().max(120).nullish(),
  about: z.string().trim().max(800).nullish(),
  /** Faixa temporária: "fechados dia 25". */
  notice: z.string().trim().max(200).nullish(),
  footerNote: z.string().trim().max(200).nullish(),
  showPrices: z.boolean(),
  leadFormEnabled: z.boolean(),
  /** AC-05 de MOD-SITE-10: vazio volta ao derivado, nunca fica em branco. */
  seoTitle: z.string().trim().max(60).nullish(),
  seoDescription: z.string().trim().max(160).nullish(),
}

/** O conteúdo completo, com os padrões — a leitura e a criação da linha. */
export const SiteContentSchema = z.strictObject({
  ...SiteContentFields,
  showPrices: SiteContentFields.showPrices.default(true),
  leadFormEnabled: SiteContentFields.leadFormEnabled.default(true),
})
export type SiteContent = z.output<typeof SiteContentSchema>

/** O PATCH. Sem defaults: o que não veio não muda. */
export const SiteContentPatchSchema = z.strictObject(SiteContentFields).partial()
export type SiteContentPatch = z.input<typeof SiteContentPatchSchema>

export const SiteSettingsSchema = SiteContentSchema.extend({
  published: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
})
export type SiteSettings = z.output<typeof SiteSettingsSchema>

// ─── Fotos ───────────────────────────────────────────────────────────────────

export const SITE_PHOTO_KINDS = ['HERO', 'GALLERY'] as const
export const SitePhotoKindSchema = z.enum(SITE_PHOTO_KINDS)
export type SitePhotoKind = z.infer<typeof SitePhotoKindSchema>

/**
 * Teto da galeria (AC-02 de MOD-SITE-04).
 *
 * É limite de produto, não técnico: uma página de petshop com 40 fotos é uma página
 * que ninguém rola até o fim e que demora a carregar no 4G da calçada.
 */
export const SITE_PHOTO_LIMIT = 12

/** O mesmo teto do álbum do pet (MOD-PET-08): 8 MB por arquivo. */
export const SITE_PHOTO_MAX_BYTES = 8 * 1024 * 1024

export const SITE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export const SitePhotoSchema = z.object({
  id: z.uuid(),
  /** Endereço público, servido pelo host do tenant. O bucket continua privado. */
  url: z.string(),
  alt: z.string().nullable(),
  kind: SitePhotoKindSchema,
  position: z.number().int(),
})
export type SitePhoto = z.output<typeof SitePhotoSchema>

export const SitePhotoPatchSchema = z
  .strictObject({
    alt: z.string().trim().max(120).nullish(),
    kind: SitePhotoKindSchema.optional(),
    position: z.number().int().min(0).max(99).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Informe ao menos um campo')
export type SitePhotoPatch = z.input<typeof SitePhotoPatchSchema>

// ─── Leads ───────────────────────────────────────────────────────────────────

export const SITE_LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'DISCARDED'] as const
export const SiteLeadStatusSchema = z.enum(SITE_LEAD_STATUSES)
export type SiteLeadStatus = z.infer<typeof SiteLeadStatusSchema>

export const SITE_LEAD_STATUS_LABELS: Record<SiteLeadStatus, string> = {
  NEW: 'Novo',
  CONTACTED: 'Contatado',
  CONVERTED: 'Virou cliente',
  DISCARDED: 'Descartado',
}

/**
 * O envio do formulário público (MOD-SITE-08).
 *
 * `website` é o **honeypot**: campo escondido por CSS que nenhuma pessoa vê e todo bot
 * preenche. Quando chega preenchido, a resposta é **201 idêntica à do sucesso**, sem
 * gravar nada — responder com erro ensinaria o bot a contornar (RN-08, e a mesma regra
 * do MOD-PORTAL-11).
 *
 * **Por isso o campo aceita qualquer texto aqui.** O §5 do PRD o descreve como
 * `z.string().max(0)`, e isso derrotaria o próprio AC-02: o schema recusaria o envio
 * com 422 antes de o honeypot ser consultado, e o bot aprenderia em uma tentativa que
 * bastava não mandar o campo. Quem decide é o serviço, e o schema só transporta.
 */
export const SiteLeadInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(20).transform((value, ctx) => {
    try {
      return normalizePhoneBR(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof InvalidPhoneError ? error.message : 'Telefone inválido',
      })
      return z.NEVER
    }
  }),
  email: z.email().max(160).optional(),
  message: z.string().trim().min(3).max(1000).optional(),
  website: z.string().max(200).optional(),
})
export type SiteLeadInput = z.input<typeof SiteLeadInputSchema>

export const SiteLeadSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  message: z.string().nullable(),
  status: SiteLeadStatusSchema,
  /** AC-04: o telefone casa com um tutor do tenant — não é aquisição. */
  existingTutorId: z.uuid().nullable(),
  convertedTutorId: z.uuid().nullable(),
  note: z.string().nullable(),
  purgedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type SiteLead = z.output<typeof SiteLeadSchema>

export const SiteLeadPatchSchema = z.strictObject({
  status: SiteLeadStatusSchema.exclude(['CONVERTED']).optional(),
  note: z.string().trim().max(500).nullish(),
})
export type SiteLeadPatch = z.input<typeof SiteLeadPatchSchema>

export const SiteLeadListSchema = z.object({
  items: z.array(SiteLeadSchema),
  total: z.number().int(),
  newCount: z.number().int(),
})


/** RN-11: prazo até o descarte automático, e do descarte até apagar o PII. */
export const SITE_LEAD_DISCARD_AFTER_DAYS = 365
export const SITE_LEAD_PURGE_AFTER_DAYS = 365
/** Metadado antiabuso tem prazo próprio, mais curto. */
export const SITE_LEAD_ABUSE_METADATA_DAYS = 90

/** AC-03 de MOD-SITE-08: teto do formulário público, por IP. */
export const SITE_LEAD_RATE_LIMIT = { max: 3, windowSeconds: 15 * 60 } as const

// ─── O payload público ───────────────────────────────────────────────────────

export const PublicSiteServiceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /**
   * `MIN(service_pricing.price_cents)`. Nulo quando o serviço não tem tabela — e aí a
   * página diz "consulte" em vez de esconder o serviço (AC-02 de MOD-SITE-05).
   */
  fromPriceCents: z.number().int().nullable(),
})

/**
 * O que o Next recebe para renderizar. **Nada aqui é dado de cliente** (RN-03): a
 * superfície pública não tem caminho até `tutors`, `pets`, `appointments` ou
 * `ledger_entries`, nem por engano.
 */
export const PublicSiteResponseSchema = z.object({
  tenant: z.object({
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
  }),
  branding: BrandingSchema,
  address: TenantAddressSchema.nullable(),
  contact: z.object({
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
  }),
  businessHours: BusinessHoursSchema,
  content: SiteContentSchema,
  photos: z.array(SitePhotoSchema),
  services: z.array(PublicSiteServiceSchema),
  cta: z.object({
    /** Nulo quando o agendamento online está desligado: o botão vira WhatsApp (AC-02). */
    bookingUrl: z.string().nullable(),
    /** O leva-e-traz aparece como destaque à parte, nunca na vitrine (AC-03). */
    taxiHighlighted: z.boolean(),
    leadFormEnabled: z.boolean(),
  }),
  seo: z.object({
    title: z.string(),
    description: z.string(),
    canonicalUrl: z.string(),
    ogImageUrl: z.string().nullable(),
  }),
})
export type PublicSiteResponse = z.output<typeof PublicSiteResponseSchema>

// ─── Publicação ──────────────────────────────────────────────────────────────

/**
 * Os estados de conta em que o site do petshop responde (RN-06).
 *
 * **Diverge da letra do PRD**, que diz "tenant com `status` diferente de `ACTIVE` →
 * 404". Aplicada ao pé da letra, essa regra tira do ar o site de todo cliente em
 * avaliação — `TRIAL` é o estado em que o tenant nasce e passa os primeiros trinta
 * dias, justamente quando ele mais quer ver que a página funciona. E `PAST_DUE` existe
 * *porque* não é suspensão: cortar o site no dia em que o cartão falha apagaria a
 * diferença entre os dois estados.
 *
 * O que a regra protege é o caso que o PRD descreve — "uma página no ar de um cliente
 * que parou de pagar é a pior propaganda possível do produto" —, e quem descreve isso é
 * `SUSPENDED` e `TERMINATED`. `PROVISIONING` e `PROVISIONING_FAILED` ficam de fora por
 * outro motivo: não há tenant montado para servir.
 */
export const SITE_VISIBLE_TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const

export function isSiteVisibleStatus(status: string): boolean {
  return (SITE_VISIBLE_TENANT_STATUSES as readonly string[]).includes(status)
}

export const SITE_PUBLISH_REQUIREMENTS = ['address', 'contact', 'service'] as const
export type SitePublishRequirement = (typeof SITE_PUBLISH_REQUIREMENTS)[number]

/**
 * AC-02 de MOD-SITE-01. Publicar uma página que não diz onde o petshop fica é pior
 * que não ter página: quem chega nela conclui que o negócio não existe mais.
 */
export const SITE_PUBLISH_REQUIREMENT_LABELS: Record<SitePublishRequirement, string> = {
  address: 'Endereço do estabelecimento',
  contact: 'Telefone ou WhatsApp público',
  service: 'Ao menos um serviço ativo visível no site',
}

export const SitePreviewSchema = z.object({
  published: z.boolean(),
  missing: z.array(z.enum(SITE_PUBLISH_REQUIREMENTS)),
  site: PublicSiteResponseSchema,
})
export type SitePreview = z.output<typeof SitePreviewSchema>
