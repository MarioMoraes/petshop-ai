-- MOD-DOC fatia 2 — o receituário veterinário e o CRMV do profissional.
--
-- Escrita à mão, como as anteriores. O `prisma migrate diff` volta a propor a poda de
-- índices parciais e de expressão que o `schema.prisma` não sabe declarar, o
-- `DROP DEFAULT` da coluna gerada do ledger e o `tenants_slug_key` total por cima do
-- parcial. Nada disso entrou — ver `prisma/migrations/README.md`.

-- ─── O registro do prescritor (MOD-DOC-05) ───────────────────────────────────
--
-- `ERR_PRONT_009` ("Prescrição exige CRMV") está no catálogo de erros desde o
-- MOD-PRONT e **nenhuma rota conseguia levantá-lo**, porque `professionals` não tinha
-- onde guardar o registro. Estas duas colunas é que tornam a RN-10 aplicável.
--
-- Duas colunas e não uma: o número e a UF são digitados em campos separados na tela, e
-- o que vai para o papel (`12345/SP`) é a junção dos dois. Guardar só a string composta
-- impediria qualquer busca por UF, e guardar só o número perderia metade do registro.

ALTER TABLE "professionals" ADD COLUMN "crmv" VARCHAR(20);
ALTER TABLE "professionals" ADD COLUMN "crmv_state" CHAR(2);

-- ─── O receituário (MOD-DOC-04) ──────────────────────────────────────────────
--
-- Fecha o MOD-PRONT-07, que ficou de fora do prontuário justamente por depender do
-- módulo de documentos.
--
-- Não há coluna de status: o estado da prescrição é "emitida" ou "anulada", e a
-- anulação é a presença de `voided_at`. O estado do **arquivo** mora em `documents`,
-- que é quem sabe se o Gotenberg respondeu.

CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "vet_id" UUID NOT NULL,
    "crmv" VARCHAR(20) NOT NULL,
    "items_encrypted" TEXT NOT NULL,
    "instructions_encrypted" TEXT,
    "document_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,
    "voided_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_pet_id_fkey"
  FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_attendance_id_fkey"
  FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_vet_id_fkey"
  FOREIGN KEY ("vet_id") REFERENCES "professionals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "prescriptions_document_id_key" ON "prescriptions" ("document_id");

CREATE INDEX "idx_prescriptions_tenant_pet"
  ON "prescriptions" ("tenant_id", "pet_id", "issued_at" DESC);

-- O painel do atendimento pergunta "que receituários saíram daqui?" a cada abertura.
CREATE INDEX "idx_prescriptions_tenant_attendance"
  ON "prescriptions" ("tenant_id", "attendance_id");

-- Anulação sem motivo é exclusão disfarçada. A regra é do atendimento (MOD-PRONT-09) e
-- vale igual aqui — com a diferença de que aqui o banco a garante, porque o que se
-- anula é um papel que alguém levou para casa.
ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_void_reason_check"
  CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL));

ALTER TABLE "prescriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prescriptions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Permissões dos papéis da aplicação ──────────────────────────────────────
--
-- O `ALTER DEFAULT PRIVILEGES` da migration de RLS já cobriria, mas ele vale para
-- tabela criada pelo mesmo papel que o executou — e uma migration aplicada por outro
-- dono deixaria a tabela muda sem erro nenhum aqui.
GRANT SELECT, INSERT, UPDATE, DELETE ON "prescriptions" TO app_user, app_maintenance;
