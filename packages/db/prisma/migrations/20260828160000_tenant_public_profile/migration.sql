-- Perfil público do estabelecimento (MOD-SITE-02) e domínio próprio (MOD-SITE-12).
--
-- Três lacunas do modelo que o PRD do site revelou, e que não são do site:
--   1. o tenant não tinha endereço físico em lugar nenhum do schema — havia CNPJ
--      cifrado e endereço de tutor, e as zonas do taxi são por faixa de CEP, mas o
--      petshop não tinha rua. Sem isso não há site, mapa, SEO local nem cabeçalho de
--      recibo com o endereço de quem emitiu;
--   2. não havia telefone público: o número do MOD-CRM é de disparo, não de exibição;
--   3. `tenants` não tinha campo de domínio, só `slug`.
--
-- O endereço **não é cifrado**, ao contrário de `tutor_addresses`. O do tutor é
-- residencial e é dado pessoal; este é comercial e o módulo existe para publicá-lo.

ALTER TABLE "tenant_settings"
  ADD COLUMN "address_zip"        VARCHAR(8),
  ADD COLUMN "address_street"     VARCHAR(120),
  ADD COLUMN "address_number"     VARCHAR(10),
  ADD COLUMN "address_complement" VARCHAR(60),
  ADD COLUMN "address_district"   VARCHAR(80),
  ADD COLUMN "address_city"       VARCHAR(80),
  ADD COLUMN "address_state"      CHAR(2),
  ADD COLUMN "latitude"           DECIMAL(10,7),
  ADD COLUMN "longitude"          DECIMAL(10,7),
  ADD COLUMN "public_phone"       VARCHAR(20),
  ADD COLUMN "public_whatsapp"    VARCHAR(20);

-- Endereço pela metade é pior que endereço nenhum: o site publicaria "Rua sem
-- número, sem bairro" e quem chegasse nele concluiria que o negócio não existe mais.
-- O complemento fica de fora porque é legitimamente opcional.
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_address_complete" CHECK (
    (
      "address_zip" IS NULL AND "address_street" IS NULL AND "address_number" IS NULL
      AND "address_district" IS NULL AND "address_city" IS NULL AND "address_state" IS NULL
    )
    OR
    (
      "address_zip" IS NOT NULL AND "address_street" IS NOT NULL AND "address_number" IS NOT NULL
      AND "address_district" IS NOT NULL AND "address_city" IS NOT NULL AND "address_state" IS NOT NULL
    )
  );

-- MOD-SITE-12: modelado, não implementado. Nenhum tenant sai de NULL na v1.
CREATE TYPE "CustomDomainStatus" AS ENUM ('PENDING', 'VERIFYING', 'ACTIVE', 'FAILED');

ALTER TABLE "tenants"
  ADD COLUMN "custom_domain"             VARCHAR(253),
  ADD COLUMN "custom_domain_status"      "CustomDomainStatus",
  ADD COLUMN "custom_domain_verified_at" TIMESTAMPTZ(6);

-- Índice único total, e não parcial: o Postgres trata NULLs como distintos, então N
-- tenants sem domínio convivem. Dois tenants não podem reivindicar o mesmo domínio —
-- é o que impede um de emitir certificado para o host do outro quando o MOD-SITE-12
-- entrar (RN-16).
CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants" ("custom_domain");
