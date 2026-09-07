-- MOD-DOC fatia 1 — o registro de documento, a numeração e o dono do arquivo.
--
-- Escrita à mão, como as anteriores. O `prisma migrate diff` volta a propor a poda de
-- índices parciais e de expressão que o `schema.prisma` não sabe declarar, o
-- `DROP DEFAULT` da coluna gerada do ledger e o `tenants_slug_key` total por cima do
-- parcial. Nada disso entrou — ver `prisma/migrations/README.md`.

-- ─── O registro ──────────────────────────────────────────────────────────────
--
-- `documents` é o dono do arquivo. `receipts` continua guardando número, status e
-- reprocesso do recibo, e passa a apontar para cá — era o `document_id` que o schema do
-- MOD-LEDGER já previa e não tinha para onde apontar.

CREATE TYPE "DocumentKind" AS ENUM ('RECEIPT', 'PRESCRIPTION', 'TERM_ACCEPTANCE', 'IMAGE_CONSENT');
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'ISSUED', 'FAILED', 'CANCELLED');

CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "tutor_id" UUID,
    "pet_id" UUID,
    "storage_key" TEXT,
    "checksum" CHAR(64),
    "size_bytes" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "issued_at" TIMESTAMPTZ(6),
    "retention_until" DATE,
    "cancelled_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A série não se repete dentro do tenant e do tipo. É a garantia de banco por trás do
-- RN-04: número de documento cancelado não volta para a fila.
CREATE UNIQUE INDEX "idx_documents_number" ON "documents" ("tenant_id", "kind", "number");

CREATE INDEX "idx_documents_tenant_kind"
  ON "documents" ("tenant_id", "kind", "issued_at" DESC);

-- A lista do Portal filtra por titularidade, nunca por tipo (AC-03 de MOD-DOC-10).
CREATE INDEX "idx_documents_tenant_tutor"
  ON "documents" ("tenant_id", "tutor_id", "issued_at" DESC);

-- O que o job de reprocesso procura. Parcial de propósito: em regime, quase nenhum
-- documento está pendente, e um índice total sobre `status` seria uma varredura cara
-- para achar as três linhas que importam.
CREATE INDEX "idx_documents_pending"
  ON "documents" ("tenant_id", "created_at")
  WHERE "status" IN ('PENDING', 'FAILED');

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "documents"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── A numeração ─────────────────────────────────────────────────────────────
--
-- Herda `receipt_counters`, agora com o tipo na chave. Uma `CREATE SEQUENCE` seria o
-- caminho óbvio e não serve: sequence é global e uma por tenant exigiria DDL em tempo
-- de execução.

CREATE TABLE "document_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("tenant_id", "kind", "year")
);

ALTER TABLE "document_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_counters"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O contador do recibo muda de casa com o valor corrente. A série já emitida
-- (`2026/000123`) **não** é renumerada: renumerar documento emitido é reescrever papel
-- entregue.
INSERT INTO "document_counters" ("tenant_id", "kind", "year", "last_number")
SELECT c."tenant_id", 'RECEIPT'::"DocumentKind", c."year", c."last_number"
  FROM "receipt_counters" c
  JOIN "tenants" t ON t."id" = c."tenant_id";

DROP TABLE "receipt_counters";

-- ─── O recibo passa a apontar para o registro ────────────────────────────────

ALTER TABLE "receipts" ADD COLUMN "document_id" UUID;

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "receipts_document_id_key" ON "receipts" ("document_id");

-- Backfill: cada recibo existente ganha a sua linha em `documents`, com o mesmo
-- arquivo, o mesmo número e a mesma data.
--
-- O `JOIN tenants` não é decoração: `receipts` é uma das 48 tabelas que ficaram fora do
-- cascade de `tenants`, e o banco de desenvolvimento tem recibo de tenant apagado. Linha
-- órfã já é inalcançável pela RLS; arrastá-la para `documents`, que **tem** FK, só faria
-- a migration falhar — e falhou, na primeira tentativa.
--
-- `SENT` do recibo mapeia para `ISSUED` do documento: a entrega é fato da mensagem, e o
-- documento não sabe nada sobre e-mail. `PENDING` continua pendente e volta para o job.
INSERT INTO "documents" (
  "id", "tenant_id", "kind", "number", "tutor_id",
  "storage_key", "status", "issued_at", "retention_until",
  "cancelled_at", "last_error", "attempts", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  r."tenant_id",
  'RECEIPT'::"DocumentKind",
  r."number",
  r."tutor_id",
  r."storage_key",
  CASE r."status"
    WHEN 'PENDING'   THEN 'PENDING'::"DocumentStatus"
    WHEN 'ISSUED'    THEN 'ISSUED'::"DocumentStatus"
    WHEN 'SENT'      THEN 'ISSUED'::"DocumentStatus"
    WHEN 'CANCELLED' THEN 'CANCELLED'::"DocumentStatus"
  END,
  r."issued_at",
  (COALESCE(r."issued_at", r."created_at") + INTERVAL '5 years')::DATE,
  r."cancelled_at",
  r."last_error",
  r."attempts",
  r."created_at",
  r."updated_at"
FROM "receipts" r
JOIN "tenants" t ON t."id" = r."tenant_id";

UPDATE "receipts" r
   SET "document_id" = d."id"
  FROM "documents" d
 WHERE d."tenant_id" = r."tenant_id"
   AND d."kind" = 'RECEIPT'
   AND d."number" = r."number";

-- `receipts.storage_key` **não cai aqui**. Para de ser escrita a partir desta fatia e
-- vira leitura de reserva; sai numa segunda migration, depois da janela de convivência.
-- Derrubar a coluna e o backfill no mesmo passo tiraria o caminho de volta.

-- ─── Permissões dos papéis da aplicação ──────────────────────────────────────
--
-- O `ALTER DEFAULT PRIVILEGES` da migration de RLS já cobriria as duas, mas ele vale
-- para tabela criada pelo mesmo papel que o executou — e uma migration aplicada por
-- outro dono deixaria as tabelas mudas sem erro nenhum aqui. Explícito custa duas linhas.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "documents",
  "document_counters"
  TO app_user, app_maintenance;
