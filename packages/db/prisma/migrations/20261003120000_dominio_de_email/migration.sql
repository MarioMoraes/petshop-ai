-- MOD-NOTIF — o domínio de e-mail próprio do estabelecimento.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- O e-mail ao tutor saía sempre do domínio da PetShop AI (`MAIL_FROM`). Agora o petshop
-- pode cadastrar o dele — `contato@meupetshop.com.br` — em Configurações › Integrações. O
-- domínio é registrado na conta Resend **da plataforma** pela API de Domains: o petshop
-- não abre conta em lugar nenhum, só publica os registros de DNS que a tela mostra.
--
-- Uma linha por tenant, e o domínio é único **entre** tenants: o Resend não aceita o
-- mesmo domínio duas vezes na conta, e dois petshops assinando pelo mesmo endereço seria
-- um se passando pelo outro. O índice único enxerga através da RLS, que é o que se quer.
--
-- `records` guarda o que o Resend devolveu para a tela desenhar a tabela de DNS sem
-- consultá-lo a cada visita.

CREATE TYPE "EmailDomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

CREATE TABLE "email_domains" (
    "tenant_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "local_part" VARCHAR(64) NOT NULL DEFAULT 'contato',
    "resend_domain_id" VARCHAR(64) NOT NULL,
    "status" "EmailDomainStatus" NOT NULL DEFAULT 'PENDING',
    "records" JSONB NOT NULL DEFAULT '[]',
    "verified_at" TIMESTAMPTZ(6),
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_domains_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "email_domains_domain_lower" CHECK ("domain" = lower("domain"))
);

CREATE UNIQUE INDEX "email_domains_domain_key" ON "email_domains"("domain");
CREATE INDEX "idx_email_domains_pending" ON "email_domains"("status") WHERE "status" = 'PENDING';

ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "email_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_domains"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O `GRANT ... ON ALL TABLES` da migration de RLS já rodou; tabela nova não é
-- alcançada por ele. O `app_maintenance` é quem varre os pendentes de todos os tenants.
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_domains" TO app_user, app_maintenance;
