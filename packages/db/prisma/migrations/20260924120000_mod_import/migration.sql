-- MOD-IMPORT — a carga da base do sistema anterior.
--
-- Escrita à mão, pelo mesmo motivo de toda migration desde o MOD-TUTOR (ver README.md).
--
-- Duas tabelas, e é o que separa a importação de um `COPY` de madrugada: elas guardam o
-- que ENTROU, linha por linha, e é essa lista que permite desfazer. Nenhum dado de
-- domínio é escrito por aqui — tutor, pet, profissional e agendamento entram pelos
-- serviços dos módulos donos, por porta declarada, com a mesma validação, a mesma
-- cifragem e a mesma trilha do cadastro feito à mão.

CREATE TYPE "ImportEntity" AS ENUM ('TUTOR', 'PET', 'PROFISSIONAL', 'AGENDA');
CREATE TYPE "ImportBatchStatus" AS ENUM ('APLICADO', 'DESFEITO');
CREATE TYPE "ImportOutcome" AS ENUM ('CRIADO', 'ATUALIZADO', 'IGNORADO', 'ERRO');

CREATE TABLE "import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    -- SHA-256 do conteúdo. É o que permite avisar "este arquivo já foi aplicado em tal
    -- dia" a quem sobe duas vezes. **Avisa, não bloqueia**: reaplicar depois de corrigir
    -- algumas linhas é o caminho normal, e travar pelo hash obrigaria a mexer no arquivo
    -- só para mudar o hash.
    "file_hash" VARCHAR(64) NOT NULL,
    -- O mapeamento coluna → campo que o humano confirmou. Sem ele, reler o relatório de
    -- um lote antigo não diria de onde cada valor veio.
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "ignored_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'APLICADO',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_import_batches_tenant" ON "import_batches" ("tenant_id", "created_at" DESC);

-- Uma linha por linha do arquivo. Trilha e lista de desfazer ao mesmo tempo.
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    -- Repetida do lote de propósito: o desfazer percorre por (lote, resultado) e a
    -- consulta não precisa do JOIN só para saber o que apagar.
    "entity" "ImportEntity" NOT NULL,
    "line_no" INTEGER NOT NULL,
    -- A chave natural daquela linha (CPF, nome do pet, nome do profissional) — é o que o
    -- relatório mostra para o operador achá-la na planilha dele.
    "ref" VARCHAR(200),
    "outcome" "ImportOutcome" NOT NULL,
    "entity_id" UUID,
    "message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id")
        REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "import_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_import_rows_batch" ON "import_rows" ("batch_id", "outcome");

-- ─── Isolamento ──────────────────────────────────────────────────────────────
--
-- O relatório de um lote é a planilha do cliente remontada linha a linha: nome, CPF e
-- telefone da carteira inteira. Tabela nova com `tenant_id` entra com RLS na mesma
-- migration (README.md), e os dois modelos entram em `RLS_MODELS`.

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_batches"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_rows"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "import_batches" TO app_user, app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON "import_rows" TO app_user, app_maintenance;
