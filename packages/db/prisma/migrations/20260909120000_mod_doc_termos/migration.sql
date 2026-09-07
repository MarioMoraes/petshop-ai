-- MOD-DOC fatia 3 — termos versionados, termo de responsabilidade e uso de imagem.
--
-- Escrita à mão, como as anteriores. O `prisma migrate diff` continua propondo a poda de
-- índices parciais e de expressão que o `schema.prisma` não sabe declarar, o
-- `DROP DEFAULT` da coluna gerada do ledger e o `tenants_slug_key` total por cima do
-- parcial. Nada disso entrou — ver `prisma/migrations/README.md`.

-- ─── O canal do termo de responsabilidade (MOD-DOC-07) ───────────────────────
--
-- Fica ao lado de `TERMS` e `IMAGE_USE`, que já esticavam a palavra "canal" pelo mesmo
-- motivo: o que se registra é o aceite de um texto, e a prova é a mesma linha
-- append-only com IP, user-agent e versão.
--
-- `ADD VALUE` roda dentro da transação da migration (PG 12+) desde que o valor novo não
-- seja **usado** aqui dentro. Não é: quem passa a gravá-lo é a rota do aceite.

ALTER TYPE "ConsentChannel" ADD VALUE 'SERVICE_LIABILITY';

-- ─── O texto do termo (MOD-DOC-06) ───────────────────────────────────────────
--
-- A tabela existe porque a prova já existia: `CURRENT_TERMS_VERSION = '1.0'` estava
-- cravada em `packages/shared-types` desde o MOD-TUTOR, e toda linha de `tutor_consents`
-- gravava esse número como prova de um documento que não existia em lugar nenhum.
--
-- Não há coluna de status nem de rascunho. Uma linha aqui **é** uma versão publicada, e
-- versão publicada é imutável: as duas rotas de escrita são inserir e nada mais.

CREATE TYPE "TermKind" AS ENUM ('TERMS', 'SERVICE_LIABILITY', 'IMAGE_USE');

CREATE TABLE "term_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" "TermKind" NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_versions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "term_versions"
  ADD CONSTRAINT "term_versions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Duas versões com o mesmo número seriam duas provas contraditórias do mesmo aceite.
CREATE UNIQUE INDEX "idx_term_versions_version"
  ON "term_versions" ("tenant_id", "kind", "version");

-- "Qual é a vigente?" é a pergunta de toda tela que apresenta um termo.
CREATE INDEX "idx_term_versions_current"
  ON "term_versions" ("tenant_id", "kind", "published_at" DESC);

ALTER TABLE "term_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "term_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "term_versions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "term_versions" TO app_user, app_maintenance;

-- ─── O papel do aceite (MOD-DOC-07 e 08) ─────────────────────────────────────
--
-- `tutor_consents` é append-only por trigger **e** por REVOKE: não há UPDATE nem para
-- `app_maintenance`. A coluna nasce preenchida no INSERT — o documento é criado na mesma
-- transação do aceite, e só o arquivo chega depois.
--
-- `RESTRICT` e não `CASCADE`: apagar o documento não pode deixar a prova sem o papel que
-- ela cita. Documento emitido não se apaga (RN-17), e este é o segundo cadeado.

ALTER TABLE "tutor_consents" ADD COLUMN "document_id" UUID;

ALTER TABLE "tutor_consents"
  ADD CONSTRAINT "tutor_consents_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "tutor_consents_document_id_key" ON "tutor_consents" ("document_id");

-- ─── O parque existente (AC-02 de MOD-DOC-06) ────────────────────────────────
--
-- Todo consentimento já gravado cita a versão `1.0`. Sem estas linhas, a primeira
-- validação contra `term_versions` invalidaria de uma vez tudo o que foi aceito até
-- aqui — e o módulo teria criado, por outro caminho, exatamente o defeito que veio
-- corrigir.
--
-- O texto é o mesmo `PLATFORM_TERM_SEEDS` de `packages/shared-types/src/terms.ts`, que o
-- provisionamento usa para o tenant novo. Mudar aquele texto **exige subir a versão do
-- seed**: o que está aqui já foi publicado, e publicado não se reescreve.
--
-- `published_by` fica nulo de propósito: quem publicou foi a plataforma, não uma pessoa.

INSERT INTO "term_versions" ("tenant_id", "kind", "version", "title", "body", "published_at")
SELECT t."id", seed.kind, '1.0', seed.title, seed.body, t."created_at"
  FROM "tenants" t
  CROSS JOIN (VALUES
    ('TERMS'::"TermKind", $seed$Termos de uso e política de privacidade$seed$, $seed$## Objeto

Este termo rege a relação entre o tutor e o estabelecimento quanto ao cadastro,
ao agendamento e à prestação de serviços de banho, tosa, atendimento veterinário
e transporte, quando contratados.

## Dados pessoais

O estabelecimento trata os dados do tutor e do animal para **executar o contrato**
de prestação de serviços, cumprir obrigações legais e manter o histórico clínico do
animal, nos termos da Lei 13.709/2018 (LGPD).

- Dados de contato são usados para confirmação, lembrete e aviso de serviço;
- comunicação de marketing depende de autorização específica, revogável a qualquer momento;
- o histórico clínico é guardado pelo prazo exigido pela legislação sanitária e veterinária.

## Direitos do titular

O tutor pode, a qualquer tempo, confirmar a existência de tratamento, acessar,
corrigir e solicitar a exclusão de seus dados, bem como revogar consentimentos,
pelo portal do cliente ou diretamente no balcão.

## Vigência

Este termo vale enquanto durar a relação entre as partes. Uma versão nova não
apaga a anterior: o aceite registrado continua provando o texto que valia no dia.$seed$),
    ('SERVICE_LIABILITY'::"TermKind", $seed$Termo de responsabilidade e ciência de riscos$seed$, $seed$## Declaração do tutor

O tutor declara ser o responsável pelo animal identificado nesta folha e prestar
informações **verdadeiras e completas** sobre a saúde, o comportamento e o histórico
dele, incluindo alergias, doenças, medicações em uso e episódios de agressividade.

## Riscos inerentes

O tutor está ciente de que os serviços de banho, tosa, higiene e transporte envolvem
contenção física do animal e de que há riscos que não decorrem de falha do
estabelecimento, entre eles:

- reação de estresse, vômito, diarreia ou vocalização durante o procedimento;
- pequenos cortes e irritação de pele, sobretudo em animais com nós, pelo emaranhado ou pele sensível;
- agravamento de condição de saúde preexistente não informada;
- em animais idosos, braquicefálicos ou cardiopatas, risco aumentado durante a contenção e a secagem.

## Conduta em emergência

Havendo intercorrência, o estabelecimento tentará contato imediato com o tutor. Não
sendo possível localizá-lo, fica **autorizado a tomar as providências veterinárias
de urgência** necessárias à preservação da vida do animal, correndo por conta do
tutor as despesas daí decorrentes.

## Tosa e resultado estético

O tutor está ciente de que o estado do pelo pode inviabilizar o corte pretendido e
de que, em caso de nós severos, a tosa higiênica ou a raspagem pode ser o único
procedimento seguro para o animal.

## Retirada

O animal deve ser retirado no horário combinado. A permanência além do horário de
funcionamento, quando aceita pelo estabelecimento, pode ser cobrada como diária.$seed$),
    ('IMAGE_USE'::"TermKind", $seed$Autorização de uso de imagem do animal$seed$, $seed$## Autorização

O tutor autoriza, a título **gratuito** e por prazo indeterminado, o uso da imagem
do animal identificado nesta folha, captada nas dependências do estabelecimento ou
durante a prestação dos serviços.

## Onde a imagem pode aparecer

- redes sociais do estabelecimento;
- site e portal do estabelecimento;
- material impresso de divulgação, como cartazes, folhetos e cardápios de serviço.

## Limites

A autorização alcança a imagem do **animal**, e não a do tutor ou de sua família.
Não abrange venda da imagem a terceiros, cessão a bancos de imagem nem uso que
associe o animal a conteúdo ofensivo, político ou que exponha o tutor.

## Revogação

A autorização pode ser revogada a qualquer momento, pelo portal do cliente ou no
balcão. A revogação vale para publicações futuras; o material já impresso ou
publicado será retirado de circulação na medida do possível.$seed$)
  ) AS seed(kind, title, body)
ON CONFLICT DO NOTHING;
