-- MOD-SITE — o site do estabelecimento.
--
-- A fatia 1 já entrou em `20260828160000_tenant_public_profile`: endereço, telefones
-- públicos e os campos de domínio próprio. Esta migration traz o que é do site em si —
-- o conteúdo, as fotos e os leads — mais a chave `show_on_site` no catálogo de
-- serviços, que faz da vitrine um subconjunto do catálogo e não um espelho dele.

-- ─────────────────────────────────────────────────────────────────────────────
-- Catálogo: o que o petshop presta e o que ele anuncia são coisas diferentes
-- ─────────────────────────────────────────────────────────────────────────────

-- AC-04 de MOD-SITE-05. Padrão `true`: quem cadastrou um serviço quer vendê-lo, e um
-- site que nasce sem vitrine porque a coluna nasceu `false` seria um site quebrado no
-- dia da publicação.
ALTER TABLE "services"
  ADD COLUMN "show_on_site" BOOLEAN NOT NULL DEFAULT true;

-- ─────────────────────────────────────────────────────────────────────────────
-- Conteúdo e publicação
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "site_settings" (
  "tenant_id"       UUID PRIMARY KEY,
  "published"       BOOLEAN NOT NULL DEFAULT false,
  "published_at"    TIMESTAMPTZ(6),
  "headline"        VARCHAR(120),
  "about"           VARCHAR(800),
  "notice"          VARCHAR(200),
  "footer_note"     VARCHAR(200),
  "show_prices"     BOOLEAN NOT NULL DEFAULT true,
  "lead_form_enabled" BOOLEAN NOT NULL DEFAULT true,
  "seo_title"       VARCHAR(60),
  "seo_description" VARCHAR(160),
  "og_image_url"    TEXT,
  "updated_by"      UUID,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "site_settings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Publicado sem data de publicação seria um site no ar que ninguém sabe desde quando.
ALTER TABLE "site_settings"
  ADD CONSTRAINT "site_settings_published_at_check" CHECK (
    "published" = false OR "published_at" IS NOT NULL
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Galeria
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "SitePhotoKind" AS ENUM ('HERO', 'GALLERY');

CREATE TABLE "site_photos" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    UUID NOT NULL,
  "storage_key"  TEXT NOT NULL,
  "alt"          VARCHAR(120),
  "kind"         "SitePhotoKind" NOT NULL DEFAULT 'GALLERY',
  "position"     SMALLINT NOT NULL DEFAULT 0,
  "width_px"     INTEGER,
  "height_px"    INTEGER,
  "content_type" VARCHAR(60) NOT NULL,
  "size_bytes"   INTEGER NOT NULL,
  "created_by"   UUID,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "site_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "site_photos"
  ADD CONSTRAINT "site_photos_position_check" CHECK ("position" >= 0);

CREATE INDEX "idx_site_photos_tenant_kind"
  ON "site_photos" ("tenant_id", "kind", "position");

-- ─────────────────────────────────────────────────────────────────────────────
-- Leads
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "SiteLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'DISCARDED');

CREATE TABLE "site_leads" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"          UUID NOT NULL,
  "name"               VARCHAR(120) NOT NULL,
  "phone_encrypted"    TEXT NOT NULL,
  "phone_hash"         TEXT NOT NULL,
  "email_encrypted"    TEXT,
  "message"            VARCHAR(1000),
  "status"             "SiteLeadStatus" NOT NULL DEFAULT 'NEW',
  "existing_tutor_id"  UUID,
  "converted_tutor_id" UUID,
  "note"               VARCHAR(500),
  "ip_address"         INET,
  "user_agent"         VARCHAR(300),
  "purged_at"          TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "site_leads_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Converter é apontar para o tutor criado: `CONVERTED` sem `converted_tutor_id` seria
-- um lead que a equipe marcou como ganho e ninguém consegue achar.
ALTER TABLE "site_leads"
  ADD CONSTRAINT "site_leads_converted_check" CHECK (
    "status" <> 'CONVERTED' OR "converted_tutor_id" IS NOT NULL
  );

CREATE INDEX "idx_site_leads_tenant_status"
  ON "site_leads" ("tenant_id", "status", "created_at" DESC);

-- AC-04 de MOD-SITE-08: o lead que já é cliente.
CREATE INDEX "idx_site_leads_phone_hash"
  ON "site_leads" ("tenant_id", "phone_hash");

-- Varredura do job de retenção: só as linhas que ainda têm PII a apagar.
CREATE INDEX "idx_site_leads_retention"
  ON "site_leads" ("created_at")
  WHERE "purged_at" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- `site_leads` nasce de visitante anônimo, e ainda assim tem isolamento igual ao do
-- resto: o tenant é resolvido pelo host **antes** da gravação (platform.resolveTenantBySlug),
-- e a escrita roda em `withTenant()` como qualquer outra. Anônimo é o autor, não o dado.

ALTER TABLE "site_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "site_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_photos"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "site_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "site_leads"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "site_settings", "site_photos", "site_leads"
  TO app_user, app_maintenance;
