# PRD Detalhado — Cadastro e Gestão de Tutores

**Módulo:** MOD-TUTOR
**Arquivo:** 02/15
**Prioridade:** P0
**Fase de Implementação:** 1 — Cadastros Core
**Serviço Backend:** tutor-service (porta 3002)
**Tabelas Principais:** tutors, tutor_addresses, tutor_tags, tutor_tag_assignments, tutor_consents, tutor_merge_log
**Data:** 2026-08-21
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O tutor é o cliente pagante e o titular dos dados pessoais tratados pelo petshop. Hoje esse cadastro vive em cadernos, agendas de celular e planilhas — o que produz cliente duplicado ("Maria do Thor" e "Maria Silva" são a mesma pessoa), telefone desatualizado que quebra o lembrete de WhatsApp, e nenhuma segmentação possível ("quem não vem há 90 dias?"). Este módulo transforma esse caos em uma base única, deduplicada e consentida, que é pré-requisito de tudo: sem telefone válido e opt-in registrado não há lembrete, não há campanha e não há agente de IA atendendo no WhatsApp.

**Integração sistêmica.** Upstream: MOD-IDENT (tenant, usuário autor do cadastro). Downstream: MOD-PET (vínculo N:N pet↔tutor), MOD-LEDGER (conta corrente é por tutor), MOD-AGENDA (agendamento sempre tem tutor responsável), MOD-CRM (segmentação, campanhas, opt-in), MOD-PORTAL (login e self-service do tutor), MOD-DOC (dados do tutor em recibos e termos), MOD-SEC (consentimento e direitos do titular), MOD-AI (o agente identifica o tutor pelo telefone da conversa de WhatsApp).

**Escopo desta fase.** Inclui: CRUD completo com validação de CPF/CNPJ e telefone E.164, deduplicação ativa por CPF/telefone/e-mail, endereço com preenchimento por CEP, tags de segmentação (manuais e automáticas), registro versionado de consentimento LGPD, busca full-text, visão 360º do tutor, merge de duplicatas e exclusão com anonimização. Fica para fases posteriores: importação em massa via CSV com mapeamento de colunas (Fase 1.5), score de valor/LTV do tutor, e enriquecimento automático de dados via integrações externas.

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-TUTOR-01 | CRUD de Tutor | Criar, ler, atualizar e desativar tutor pessoa física ou jurídica | Must Have |
| MOD-TUTOR-02 | Deduplicação | Bloqueio de duplicata exata e alerta de duplicata provável antes de salvar | Must Have |
| MOD-TUTOR-03 | Endereço | Um endereço principal + N adicionais, com autocompletar por CEP | Must Have |
| MOD-TUTOR-04 | Consentimento LGPD | Registro versionado de opt-in por canal e aceite de termos, com histórico imutável | Must Have |
| MOD-TUTOR-05 | Tags e Segmentação | Tags manuais (VIP) e automáticas (inativo, inadimplente) mantidas por eventos | Must Have |
| MOD-TUTOR-06 | Busca e Filtros | Busca por nome, telefone, CPF, pet e tag, com resposta < 300ms | Must Have |
| MOD-TUTOR-07 | Visão 360º | Agregação de pets, agendamentos, financeiro e comunicações do tutor | Must Have |
| MOD-TUTOR-08 | Exclusão e Anonimização | Soft delete + anonimização respeitando retenção fiscal de 5 anos | Must Have |
| MOD-TUTOR-09 | Merge de Duplicatas | Unificação de dois cadastros preservando histórico de ambos | Should Have |
| MOD-TUTOR-10 | Aniversário do Tutor | Data de nascimento alimentando campanha automática | Should Have |
| MOD-TUTOR-11 | Importação CSV | Importação em massa com pré-visualização e relatório de erros | Nice to Have |

## 3. Critérios de Aceite

### [MOD-TUTOR-01] — CRUD de Tutor

**AC-01 (Happy Path)**
- **Dado** um usuário `RECEPTIONIST` autenticado no tenant A
- **Quando** envia `POST /v1/tutors` com `{ personType: "PF", fullName: "Maria Silva", phone: "+5511987654321", cpf: "12345678901", email: "maria@exemplo.com", birthDate: "1988-04-12", consents: { whatsapp: true, email: true, terms: true } }`
- **Então** o sistema normaliza o telefone para E.164, cifra CPF/e-mail/telefone, grava `status = ACTIVE`, cria o registro de consentimento com IP e timestamp, publica `tutor.criado` e retorna **201** com o tutor (CPF mascarado como `***.***.789-01`)

**AC-02 (Validação / Erro)**
- **Dado** um CPF com dígitos verificadores inválidos (`11111111111`)
- **Quando** o cadastro é submetido
- **Então** retorna **422** `ERR_TUTOR_002` com `errors: [{ field: "cpf", message: "CPF inválido" }]`

**AC-03 (Edge Case — PF sem CPF)**
- **Dado** um atendimento de balcão em que o tutor não tem o CPF em mãos
- **Quando** o cadastro é enviado sem CPF mas com nome e telefone
- **Então** o cadastro é aceito (**201**) com `data_completeness = PARTIAL`, e o tutor aparece no painel "Cadastros incompletos"; a emissão de recibo fiscal para esse tutor exibe aviso de CPF ausente

**AC-04 (Edge Case — PJ)**
- **Dado** `personType = "PJ"`
- **Quando** o cadastro é submetido sem CNPJ ou sem razão social
- **Então** retorna **422** `ERR_TUTOR_002` "CNPJ e razão social são obrigatórios para pessoa jurídica"

### [MOD-TUTOR-02] — Deduplicação

**AC-01 (Happy Path — duplicata exata bloqueada)**
- **Dado** que já existe no tenant um tutor ativo com CPF `12345678901`
- **Quando** um novo cadastro com o mesmo CPF é submetido
- **Então** retorna **409** `ERR_TUTOR_004` com `{ existingTutor: { id, fullName, phoneMasked } }` e a UI oferece "Abrir cadastro existente"

**AC-02 (Alerta de duplicata provável)**
- **Dado** um cadastro novo cujo nome tem similaridade `pg_trgm >= 0.6` com um tutor existente **e** compartilha e-mail ou os 4 últimos dígitos do telefone
- **Quando** o usuário chama `POST /v1/tutors/check-duplicates` (executado no blur do campo nome, antes de salvar)
- **Então** retorna **200** com `{ candidates: [...], confidence: "MEDIUM" }`; salvar segue permitido com `duplicateAcknowledged = true`, registrado em auditoria

**AC-03 (Edge Case — telefone compartilhado)**
- **Dado** que marido e esposa usam o mesmo telefone
- **Quando** o segundo cadastro com o mesmo telefone é submetido
- **Então** o sistema **não bloqueia** (telefone não é chave única), exibe alerta de duplicata provável e sugere "É a mesma pessoa? Ou é outro responsável pelo mesmo pet?" — no segundo caso, orienta vincular o pet a dois tutores (MOD-PET)

**AC-04 (Edge Case — duplicata com tutor inativo)**
- **Dado** que o CPF pertence a um tutor com `status = INACTIVE` ou soft-deleted
- **Quando** o cadastro é submetido
- **Então** retorna **409** `ERR_TUTOR_004` com ação sugerida "Reativar cadastro existente", preservando todo o histórico

### [MOD-TUTOR-04] — Consentimento LGPD

**AC-01 (Happy Path)**
- **Dado** um tutor sendo cadastrado
- **Quando** marca opt-in para WhatsApp e e-mail e aceita os termos
- **Então** grava-se em `tutor_consents` um registro por canal com `granted = true`, `version` do termo, `source = STAFF_FORM`, `ip_address`, `user_agent` e `granted_at`; o registro é **append-only**

**AC-02 (Validação / Erro)**
- **Dado** um tutor que revogou o opt-in de WhatsApp
- **Quando** MOD-CRM tenta enfileirar campanha promocional para ele
- **Então** o envio é bloqueado com `ERR_TUTOR_009` e registrado como `SUPPRESSED_BY_CONSENT`; mensagens **transacionais** (confirmação e lembrete de agendamento que ele mesmo solicitou) continuam permitidas por execução de contrato

**AC-03 (Edge Case — revogação e novo opt-in)**
- **Dado** um tutor que revogou e depois reautorizou o WhatsApp
- **Quando** consultamos `GET /v1/tutors/:id/consents`
- **Então** retorna o estado **atual** (`granted = true`) e o histórico completo das 3 transições, cada uma com data, origem e IP — nenhum registro anterior é sobrescrito

**AC-04 (Edge Case — nova versão do termo)**
- **Dado** que o tenant publica a versão 2 dos termos
- **Quando** o tutor acessa o Portal
- **Então** é solicitado novo aceite; até aceitar, `consent_status = PENDING_RENEWAL` e apenas comunicações transacionais são permitidas

### [MOD-TUTOR-05] — Tags e Segmentação

**AC-01 (Happy Path)**
- **Dado** um `TENANT_ADMIN`
- **Quando** cria a tag "VIP" com cor e a atribui a 12 tutores via `POST /v1/tutors/tags/:tagId/assign`
- **Então** as atribuições são criadas idempotentemente e retorna **200** com `{ assigned: 12, alreadyAssigned: 0 }`

**AC-02 (Validação / Erro)**
- **Dado** uma tag de sistema (`is_system = true`, ex.: `INATIVO`)
- **Quando** um usuário tenta atribuí-la ou removê-la manualmente
- **Então** retorna **403** `ERR_TUTOR_003` "Tags automáticas são mantidas pelo sistema"

**AC-03 (Edge Case — tag automática recalculada)**
- **Dado** o job diário de inatividade (MOD-CRM) e o limite configurado de 90 dias
- **Quando** um tutor sem atendimento há 91 dias é avaliado
- **Então** recebe a tag `INATIVO` e publica-se `tutor.tag.aplicada`; ao realizar novo atendimento, a tag é removida automaticamente na conclusão do serviço

### [MOD-TUTOR-06] — Busca e Filtros

**AC-01 (Happy Path)**
- **Dado** 8.000 tutores no tenant
- **Quando** o atendente digita "mari" em `GET /v1/tutors?q=mari&limit=20`
- **Então** retorna em < 300ms (p95) os tutores por relevância, com os pets de cada um no payload (para desambiguar "Maria do Thor")

**AC-02 (Busca por telefone e CPF cifrados)**
- **Dado** que telefone e CPF estão cifrados em repouso
- **Quando** a busca é `q=11987654321` ou `q=123.456.789-01`
- **Então** o serviço detecta o padrão, normaliza e busca pela coluna `phone_hash` / `cpf_hash` (HMAC-SHA256 com pepper) — nunca com `LIKE` sobre texto cifrado

**AC-03 (Edge Case — busca vazia / injeção)**
- **Dado** `q` com menos de 2 caracteres, ou contendo operadores de tsquery (`&`, `|`, `!`, `:`)
- **Quando** a busca é executada
- **Então** com `q` curto retorna a lista padrão ordenada por `updated_at DESC`; caracteres especiais são escapados com `websearch_to_tsquery`, jamais concatenados na SQL

### [MOD-TUTOR-08] — Exclusão e Anonimização

**AC-01 (Happy Path — sem histórico)**
- **Dado** um tutor sem pets, sem agendamentos e sem lançamentos financeiros
- **Quando** um `TENANT_ADMIN` chama `DELETE /v1/tutors/:id`
- **Então** o registro sofre soft delete (`deleted_at`), sai de todas as listagens e retorna **204**

**AC-02 (Validação / Erro — histórico financeiro)**
- **Dado** um tutor com lançamentos na conta corrente
- **Quando** a exclusão é solicitada
- **Então** retorna **409** `ERR_TUTOR_005` "Este tutor possui histórico financeiro e não pode ser excluído. Você pode anonimizar os dados pessoais mantendo o histórico contábil." com o link para o fluxo de anonimização

**AC-03 (Edge Case — anonimização)**
- **Dado** um pedido de exclusão do titular (LGPD art. 18) para um tutor com histórico
- **Quando** o fluxo `POST /v1/tutors/:id/anonymize` é confirmado com dupla confirmação do admin
- **Então** `full_name` vira "Tutor Anonimizado #A1B2", CPF/e-mail/telefone/endereço são apagados (não apenas mascarados), `anonymized_at` é preenchido, os pets são desvinculados e mantidos como órfãos com histórico clínico, os lançamentos financeiros permanecem íntegros referenciando o `tutor_id`, e a operação é irreversível e auditada

**AC-04 (Edge Case — agendamento futuro)**
- **Dado** um tutor com agendamento futuro confirmado
- **Quando** a exclusão/anonimização é solicitada
- **Então** retorna **409** `ERR_TUTOR_005` listando os agendamentos, exigindo cancelamento prévio

### [MOD-TUTOR-09] — Merge de Duplicatas

**AC-01 (Happy Path)**
- **Dado** dois cadastros da mesma pessoa (origem e destino)
- **Quando** o admin executa `POST /v1/tutors/:targetId/merge` com `{ sourceId, fieldResolution: { phone: "source", email: "target" } }`
- **Então** em uma única transação: pets são revinculados ao destino, lançamentos financeiros são transferidos (com entrada de rastreio no ledger), agendamentos e comunicações são reapontados, o tutor origem vira `status = MERGED` apontando para o destino, grava-se `tutor_merge_log` com o snapshot completo de ambos, publica-se `tutor.mesclado` e retorna **200**

**AC-02 (Validação / Erro)**
- **Dado** uma tentativa de merge onde origem = destino, ou onde um dos lados já está `MERGED`/anonimizado
- **Quando** submetida
- **Então** retorna **422** `ERR_TUTOR_002` "Cadastros inválidos para unificação"

**AC-03 (Edge Case — saldos opostos)**
- **Dado** que o tutor origem tem saldo −R$ 120,00 e o destino +R$ 50,00
- **Quando** o merge ocorre
- **Então** os lançamentos são transferidos individualmente (nunca o saldo agregado), o saldo resultante do destino é recalculado a partir do ledger (−R$ 70,00) e uma entrada de auditoria `MERGE_TRANSFER` referencia cada lançamento movido

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| tutors | id | UUID | ✓ | PK |
| tutors | tenant_id | UUID | ✓ | Isolamento multi-tenant (RLS) |
| tutors | person_type | Enum | ✓ | PF, PJ |
| tutors | full_name | String(160) | ✓ | Nome completo ou nome fantasia |
| tutors | legal_name | String(160) | — | Razão social (PJ) |
| tutors | social_name | String(120) | — | Nome social (respeito à identidade de gênero) |
| tutors | cpf | Text (cifrado) | — | PF; obrigatório para emissão fiscal |
| tutors | cpf_hash | String | — | HMAC para unicidade e busca |
| tutors | cnpj | Text (cifrado) | — | PJ |
| tutors | cnpj_hash | String | — | HMAC para unicidade |
| tutors | phone | Text (cifrado) | ✓ | E.164, canal primário de WhatsApp |
| tutors | phone_hash | String | ✓ | HMAC para busca e dedupe |
| tutors | phone_alt | Text (cifrado) | — | Telefone secundário |
| tutors | email | Text (cifrado) | — | PII |
| tutors | email_hash | String | — | HMAC para busca e dedupe |
| tutors | birth_date | Date | — | Campanha de aniversário |
| tutors | notes | Text | — | Observações livres da operação |
| tutors | status | Enum | ✓ | ACTIVE, INACTIVE, MERGED, ANONYMIZED |
| tutors | data_completeness | Enum | ✓ | COMPLETE, PARTIAL |
| tutors | portal_user_id | UUID | — | Vínculo com login do Portal (Clerk) |
| tutors | merged_into_id | UUID | — | Destino, quando MERGED |
| tutors | search_vector | tsvector | ✓ | Índice GIN para busca full-text |
| tutors | last_attendance_at | Timestamptz | — | Denormalizado; alimenta tag INATIVO |
| tutors | anonymized_at | Timestamptz | — | Marca de anonimização irreversível |
| tutors | created_by / updated_by | UUID | ✓/— | Rastreabilidade |
| tutors | created_at / updated_at / deleted_at | Timestamptz | ✓/✓/— | Soft delete |
| tutor_addresses | id / tutor_id / tenant_id | UUID | ✓ | PK e FKs |
| tutor_addresses | label | String(40) | ✓ | Casa, Trabalho, Outro |
| tutor_addresses | zip_code | String(8) | ✓ | CEP normalizado |
| tutor_addresses | street / number / complement | String | ✓/✓/— | Logradouro |
| tutor_addresses | district / city / state | String | ✓ | UF com 2 letras |
| tutor_addresses | latitude / longitude | Decimal(9,6) | — | Geocodificação para Taxi Dog |
| tutor_addresses | is_primary | Boolean | ✓ | Exatamente um por tutor |
| tutor_addresses | access_notes | Text | — | "Portão azul, chamar no interfone 12" |
| tutor_tags | id / tenant_id | UUID | ✓ | PK |
| tutor_tags | key | String(40) | ✓ | Único por tenant |
| tutor_tags | label / color | String | ✓ | Exibição |
| tutor_tags | is_system | Boolean | ✓ | INATIVO, INADIMPLENTE, ANIVERSARIANTE |
| tutor_tag_assignments | tutor_id / tag_id / tenant_id | UUID | ✓ | PK composta |
| tutor_tag_assignments | assigned_by | UUID | — | Nulo quando automática |
| tutor_tag_assignments | assigned_at | Timestamptz | ✓ | |
| tutor_consents | id / tenant_id / tutor_id | UUID | ✓ | PK e FKs |
| tutor_consents | channel | Enum | ✓ | WHATSAPP, EMAIL, SMS, TERMS, IMAGE_USE |
| tutor_consents | granted | Boolean | ✓ | Estado desta transição |
| tutor_consents | purpose | Enum | ✓ | TRANSACTIONAL, MARKETING, BOTH |
| tutor_consents | version | String(20) | ✓ | Versão do termo aceito |
| tutor_consents | source | Enum | ✓ | STAFF_FORM, PORTAL, SITE, WHATSAPP, IMPORT |
| tutor_consents | ip_address / user_agent | Inet / String | — | Prova de consentimento |
| tutor_consents | created_at | Timestamptz | ✓ | Append-only |
| tutor_merge_log | id / tenant_id | UUID | ✓ | PK |
| tutor_merge_log | source_id / target_id | UUID | ✓ | Cadastros envolvidos |
| tutor_merge_log | snapshot | JSONB | ✓ | Estado completo pré-merge (reversão manual) |
| tutor_merge_log | moved_entities | JSONB | ✓ | `{ pets: [...], ledgerEntries: [...], appointments: [...] }` |
| tutor_merge_log | performed_by / created_at | UUID / Timestamptz | ✓ | Auditoria |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| cpf / cnpj | tutors | Identificador nacional; vazamento habilita fraude de identidade |
| phone / phone_alt | tutors | Dado pessoal de contato; alvo primário de vazamento comercial |
| email | tutors | Dado pessoal de contato |
| street / number / complement | tutor_addresses | Endereço residencial — dado sensível à segurança física do titular |

Colunas `*_hash` usam HMAC-SHA256 com pepper em secret manager, permitindo unicidade e busca exata sem decifrar. Nome permanece em claro para viabilizar busca por similaridade no balcão — decisão consciente, com acesso restrito por RBAC e RLS e leitura auditada.

### Índices Necessários

```sql
CREATE INDEX idx_tutors_tenant ON tutors(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_tutors_tenant_cpf ON tutors(tenant_id, cpf_hash)
  WHERE cpf_hash IS NOT NULL AND deleted_at IS NULL AND status <> 'MERGED';
CREATE UNIQUE INDEX idx_tutors_tenant_cnpj ON tutors(tenant_id, cnpj_hash)
  WHERE cnpj_hash IS NOT NULL AND deleted_at IS NULL AND status <> 'MERGED';
CREATE INDEX idx_tutors_tenant_phone ON tutors(tenant_id, phone_hash);
CREATE INDEX idx_tutors_tenant_email ON tutors(tenant_id, email_hash);
CREATE INDEX idx_tutors_search ON tutors USING GIN(search_vector);
CREATE INDEX idx_tutors_name_trgm ON tutors USING GIN(full_name gin_trgm_ops);
CREATE INDEX idx_tutors_birthday ON tutors(tenant_id, (EXTRACT(MONTH FROM birth_date)), (EXTRACT(DAY FROM birth_date)))
  WHERE birth_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_tutors_inactive ON tutors(tenant_id, last_attendance_at) WHERE status = 'ACTIVE';
CREATE INDEX idx_tutor_addresses_tutor ON tutor_addresses(tutor_id);
CREATE UNIQUE INDEX idx_tutor_address_primary ON tutor_addresses(tutor_id) WHERE is_primary;
CREATE INDEX idx_consents_tutor_channel ON tutor_consents(tutor_id, channel, created_at DESC);
CREATE UNIQUE INDEX idx_tags_tenant_key ON tutor_tags(tenant_id, key);
```

Trigger de atualização do `search_vector`:

```sql
CREATE FUNCTION tutors_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('portuguese', coalesce(NEW.full_name,'')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(NEW.social_name,'')), 'A') ||
    setweight(to_tsvector('portuguese', coalesce(NEW.legal_name,'')), 'B');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

## 5. Contratos de API

Todos os endpoints exigem `Authorization: Bearer <jwt>` e inferem `tenant_id` do JWT. Paginação `?page=1&limit=20`; retorno `{ data, total, page, limit }`.

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/tutors | TENANT_ADMIN, RECEPTIONIST, VET, GROOMER, BATHER | Listar com busca e filtros (`q`, `tag`, `status`, `hasDebt`, `inactiveSince`) |
| POST | /v1/tutors | TENANT_ADMIN, RECEPTIONIST, VET | Criar tutor |
| POST | /v1/tutors/check-duplicates | TENANT_ADMIN, RECEPTIONIST, VET | Verificar duplicatas antes de salvar |
| GET | /v1/tutors/:id | TENANT_ADMIN, RECEPTIONIST, VET, GROOMER, BATHER | Detalhe |
| GET | /v1/tutors/:id/overview | TENANT_ADMIN, RECEPTIONIST | Visão 360º (pets, agenda, saldo, comunicações) |
| PATCH | /v1/tutors/:id | TENANT_ADMIN, RECEPTIONIST, VET | Atualizar parcialmente |
| DELETE | /v1/tutors/:id | TENANT_ADMIN | Soft delete (bloqueado se houver histórico) |
| POST | /v1/tutors/:id/anonymize | TENANT_ADMIN | Anonimização LGPD irreversível |
| POST | /v1/tutors/:id/reactivate | TENANT_ADMIN, RECEPTIONIST | Reativar cadastro inativo |
| GET | /v1/tutors/:id/consents | TENANT_ADMIN, RECEPTIONIST | Estado atual + histórico de consentimento |
| PUT | /v1/tutors/:id/consents | TENANT_ADMIN, RECEPTIONIST, TUTOR (próprio) | Registrar nova transição de consentimento |
| GET | /v1/tutors/:id/addresses | TENANT_ADMIN, RECEPTIONIST, DRIVER (restrito) | Listar endereços |
| POST | /v1/tutors/:id/addresses | TENANT_ADMIN, RECEPTIONIST | Adicionar endereço |
| PATCH | /v1/tutors/:id/addresses/:addressId | TENANT_ADMIN, RECEPTIONIST | Atualizar endereço |
| GET | /v1/tutors/tags | TENANT_ADMIN, RECEPTIONIST | Listar tags |
| POST | /v1/tutors/tags | TENANT_ADMIN | Criar tag |
| POST | /v1/tutors/tags/:tagId/assign | TENANT_ADMIN, RECEPTIONIST | Atribuir tag a N tutores |
| DELETE | /v1/tutors/:id/tags/:tagId | TENANT_ADMIN, RECEPTIONIST | Remover tag manual |
| POST | /v1/tutors/:targetId/merge | TENANT_ADMIN | Unificar duplicatas |
| GET | /v1/tutors/:id/export | TENANT_ADMIN, TUTOR (próprio) | Portabilidade LGPD (JSON/CSV) |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const PhoneBRSchema = z.string()
  .transform(v => v.replace(/\D/g, ''))
  .refine(v => /^(55)?\d{10,11}$/.test(v), 'Telefone inválido')
  .transform(v => `+${v.startsWith('55') ? v : '55' + v}`)

export const CPFSchema = z.string()
  .transform(v => v.replace(/\D/g, ''))
  .refine(isValidCPF, 'CPF inválido')

export const ConsentChannelSchema = z.enum(['WHATSAPP','EMAIL','SMS','TERMS','IMAGE_USE'])

export const CreateTutorSchema = z.object({
  personType: z.enum(['PF','PJ']).default('PF'),
  fullName: z.string().min(3).max(160),
  socialName: z.string().max(120).optional(),
  legalName: z.string().max(160).optional(),
  cpf: CPFSchema.optional(),
  cnpj: z.string().regex(/^\d{14}$/).optional(),
  phone: PhoneBRSchema,
  phoneAlt: PhoneBRSchema.optional(),
  email: z.string().email().optional(),
  birthDate: z.string().date().optional(),
  notes: z.string().max(2000).optional(),
  address: z.object({
    zipCode: z.string().regex(/^\d{8}$/),
    street: z.string().min(3).max(160),
    number: z.string().max(20),
    complement: z.string().max(80).optional(),
    district: z.string().max(80),
    city: z.string().max(80),
    state: z.string().length(2),
    accessNotes: z.string().max(300).optional(),
  }).optional(),
  consents: z.object({
    whatsapp: z.boolean(),
    email: z.boolean(),
    terms: z.literal(true, { errorMap: () => ({ message: 'Aceite dos termos é obrigatório' }) }),
    imageUse: z.boolean().default(false),
  }),
  duplicateAcknowledged: z.boolean().default(false),
}).refine(d => d.personType === 'PF' || (!!d.cnpj && !!d.legalName), {
  message: 'CNPJ e razão social são obrigatórios para pessoa jurídica', path: ['cnpj'],
})
export type CreateTutorInput = z.infer<typeof CreateTutorSchema>

export const TutorResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  personType: z.enum(['PF','PJ']),
  fullName: z.string(),
  cpfMasked: z.string().nullable(),          // ***.***.789-01
  phoneMasked: z.string(),                   // (11) *****-4321
  email: z.string().email().nullable(),
  status: z.enum(['ACTIVE','INACTIVE','MERGED','ANONYMIZED']),
  dataCompleteness: z.enum(['COMPLETE','PARTIAL']),
  tags: z.array(z.object({ key: z.string(), label: z.string(), color: z.string(), isSystem: z.boolean() })),
  petsCount: z.number().int(),
  balance: z.number(),                        // negativo = inadimplente
  lastAttendanceAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const MergeTutorSchema = z.object({
  sourceId: z.string().uuid(),
  fieldResolution: z.record(z.enum(['source','target'])).default({}),
  confirmation: z.literal('CONFIRMO_A_UNIFICACAO'),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_TUTOR_001 | 404 | Tutor não encontrado neste tenant |
| ERR_TUTOR_002 | 422 | Dados inválidos (CPF, telefone, PJ sem CNPJ) |
| ERR_TUTOR_003 | 403 | Papel insuficiente para a operação |
| ERR_TUTOR_004 | 409 | Duplicata de CPF/CNPJ no tenant |
| ERR_TUTOR_005 | 409 | Exclusão bloqueada por histórico financeiro ou agenda futura |
| ERR_TUTOR_006 | 409 | Tutor já anonimizado ou mesclado — operação indisponível |
| ERR_TUTOR_007 | 422 | Merge inválido (mesmo id, estado incompatível) |
| ERR_TUTOR_008 | 502 | Falha no serviço de CEP (cadastro segue manual) |
| ERR_TUTOR_009 | 403 | Comunicação bloqueada por ausência de consentimento |

## 6. Máquinas de Estado

### Tutor — Status

```
              ┌───────────────────────────────────────────────┐
              │                                               │
ACTIVE ──(inatividade > X dias OU desativação manual)──► INACTIVE
  │                                                        │
  │◄──────────────(novo atendimento OU reativação)─────────┘
  │
  ├─(merge como origem)──────────► MERGED (terminal, aponta merged_into_id)
  │
  └─(pedido LGPD do titular)─────► ANONYMIZED (terminal, irreversível)
```

`INACTIVE` é estado comercial (não bloqueia nada, apenas sinaliza e alimenta campanha de reativação). `MERGED` e `ANONYMIZED` são terminais: rejeitam qualquer escrita com **409** `ERR_TUTOR_006`.

### Consentimento por canal — Estado derivado

```
SEM_REGISTRO ──(opt-in)──► GRANTED ──(opt-out via UI/portal/"SAIR" no WhatsApp)──► REVOKED
                              │                                                       │
                              │◄──────────────(novo opt-in explícito)─────────────────┘
                              │
                              └─(nova versão do termo)──► PENDING_RENEWAL ──(aceite)──► GRANTED
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| — | ACTIVE | `tutor.criado` | E-mail de boas-vindas (se opt-in) | ✓ |
| ACTIVE | INACTIVE | `tutor.inativado` | Campanha de reativação (MOD-CRM) | ✓ |
| GRANTED | REVOKED | `tutor.consentimento.revogado` | Confirmação de descadastro | ✓ |
| ACTIVE | MERGED | `tutor.mesclado` | — | ✓ |
| ACTIVE | ANONYMIZED | `tutor.anonimizado` | Confirmação ao titular (antes de apagar o e-mail) | ✓ |

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Unicidade | CPF e CNPJ são únicos **por tenant** (não globais): a mesma pessoa pode ser cliente de dois petshops | MOD-TUTOR, MOD-IDENT |
| RN-02 | Telefone não é chave única | Famílias compartilham número; gera alerta, nunca bloqueio | MOD-TUTOR, MOD-CRM |
| RN-03 | Telefone é obrigatório | É o canal primário (WhatsApp) e chave de identificação do agente de IA | MOD-CRM, MOD-AI |
| RN-04 | Normalização E.164 | Todo telefone é persistido como `+55DDDNNNNNNNN`; 8 dígitos em celular recebem o 9 quando o DDD exigir | MOD-CRM, MOD-AI |
| RN-05 | Consentimento é append-only | Revogação nunca apaga o opt-in anterior; a prova histórica é a defesa do tenant perante a ANPD | MOD-SEC |
| RN-06 | Transacional vs. marketing | Opt-out de marketing não bloqueia confirmação/lembrete de serviço contratado (execução de contrato) | MOD-CRM, MOD-NOTIF |
| RN-07 | Exclusão com histórico | Nunca exclusão física: soft delete + anonimização, retendo lançamentos por 5 anos (fiscal) | MOD-LEDGER, MOD-SEC |
| RN-08 | Anonimização é irreversível | Sem "desfazer"; exige dupla confirmação e é auditada com justificativa | MOD-SEC, MOD-ADMIN |
| RN-09 | Pet órfão pós-anonimização | Pet permanece com histórico clínico e sem tutor; qualquer agendamento exige vincular novo tutor | MOD-PET, MOD-AGENDA |
| RN-10 | `last_attendance_at` | Atualizado por consumo do evento `atendimento.concluido`; nunca calculado on-the-fly em listagem | MOD-PRONT, MOD-AGENDA |
| RN-11 | Concorrência no cadastro | Dois atendentes cadastrando o mesmo CPF simultaneamente: o índice único resolve; o perdedor recebe 409 com link para o cadastro criado | MOD-TUTOR |
| RN-12 | Tag INADIMPLENTE | Aplicada/removida por eventos do ledger (`saldo < 0` por mais de N dias), nunca manualmente | MOD-LEDGER, MOD-CRM |
| RN-13 | Tutor com login no Portal | `portal_user_id` vincula ao Clerk; alterar e-mail no Portal exige reverificação antes de propagar | MOD-PORTAL, MOD-IDENT |
| RN-14 | Nome social | Quando preenchido, é o nome exibido em todas as telas e comunicações; nome civil só aparece em documentos fiscais | MOD-DOC, MOD-CRM |
| RN-15 | Endereço principal único | Definir um novo endereço como principal rebaixa o anterior na mesma transação | MOD-TAXI |

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `tutor.criado` | tutor-service | crm-automation, notification, audit, agent-orchestrator | `{ tenantId, tutorId, phone, hasWhatsappConsent, timestamp }` |
| `tutor.atualizado` | tutor-service | crm-automation, portal-bff, audit | `{ tenantId, tutorId, changedFields[], timestamp }` |
| `tutor.inativado` | tutor-service | crm-automation, audit | `{ tenantId, tutorId, lastAttendanceAt, timestamp }` |
| `tutor.consentimento.revogado` | tutor-service | crm-automation, messaging, notification, audit | `{ tenantId, tutorId, channel, purpose, timestamp }` |
| `tutor.consentimento.concedido` | tutor-service | crm-automation, audit | `{ tenantId, tutorId, channel, purpose, version, timestamp }` |
| `tutor.mesclado` | tutor-service | pet, billing-ledger, scheduling, crm-automation, audit | `{ tenantId, sourceId, targetId, movedEntities, timestamp }` |
| `tutor.anonimizado` | tutor-service | todos os serviços, audit | `{ tenantId, tutorId, timestamp }` |
| `tutor.tag.aplicada` / `tutor.tag.removida` | tutor-service | crm-automation, audit | `{ tenantId, tutorId, tagKey, automatic, timestamp }` |

Consome: `atendimento.concluido` (atualiza `last_attendance_at` e remove tag INATIVO), `lancamento.criado` (recalcula tag INADIMPLENTE), `mensagem.recebida` com corpo "SAIR"/"PARAR" (revoga opt-in de marketing).

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Listar | ✓¹ | ✓ | ✓ | ✓ (nome + telefone) | ✓ | — | — |
| Ver detalhe | ✓¹ | ✓ | ✓ | parcial | ✓ | corrida atribuída | próprio |
| Criar | — | ✓ | ✓ | — | ✓ | — | — |
| Editar | — | ✓ | ✓ | — | ✓ | — | próprio² |
| Excluir (soft) | — | ✓ | — | — | — | — | — |
| Anonimizar | ✓¹ | ✓ | — | — | — | — | solicita |
| Merge | — | ✓ | — | — | — | — | — |
| Ver CPF completo | — | ✓ | ✓³ | — | — | — | próprio |
| Gerenciar tags | — | ✓ | ✓ (manuais) | — | — | — | — |
| Exportar dados | ✓¹ | ✓ | — | — | — | — | próprio |

¹ Somente com `support_access_grant` ativo e justificativa; cada leitura é auditada individualmente (MOD-ADMIN).
² Tutor edita apenas telefone, e-mail, endereço e preferências — nunca CPF ou nome civil sem verificação.
³ Recepção vê CPF completo apenas na tela de emissão de recibo; nas demais, mascarado.

### Audit Log — ações que DEVEM gerar registro imutável

- `tutor.created`, `tutor.updated` (com diff de campos, PII mascarada) → `action`, `entity`, `entityId`, `userId`, `tenantId`, `before`, `after`, `ipAddress`
- `tutor.deleted`, `tutor.anonymized` (com justificativa obrigatória), `tutor.merged`
- `tutor.cpf_revealed` — toda exibição de CPF completo
- `tutor.exported` — portabilidade LGPD
- `consent.granted`, `consent.revoked`
- `tutor.duplicate_override` — quando o alerta de duplicata é ignorado

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| full_name, social_name | Dado pessoal | Execução de contrato | Relação ativa + 5 anos | ✓ | ✓ (anonimização) |
| cpf / cnpj | Dado pessoal | Obrigação legal (fiscal) | 5 anos após último lançamento | ✓ | ✓ após retenção |
| phone, email | Dado pessoal | Execução de contrato + consentimento (marketing) | Relação ativa + 5 anos | ✓ | ✓ |
| birth_date | Dado pessoal | Consentimento (campanha) | Enquanto houver opt-in | ✓ | ✓ |
| endereço | Dado pessoal | Execução de contrato (Taxi Dog) | Relação ativa + 5 anos | ✓ | ✓ |
| tutor_consents | Prova de conformidade | Obrigação legal (ANPD) | 5 anos após revogação | ✓ | — |
| notes (campo livre) | Risco de dado sensível | Legítimo interesse | Relação ativa | ✓ | ✓ |

> `notes` é campo livre e pode receber dado sensível indevidamente ("tutor tem deficiência", "é idoso"). A UI deve exibir aviso de não registrar dados de saúde do tutor, e o campo entra integralmente na exportação e na anonimização.

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Detalhe do tutor | 120s | `tutor:{tenantId}:{tutorId}` | `tutor.atualizado`, `tutor.tag.*` |
| Consentimentos efetivos | 300s | `tutor:consent:{tenantId}:{tutorId}` | `tutor.consentimento.*` |
| Resolução telefone → tutorId (agente IA) | 600s | `tutor:phone:{tenantId}:{phoneHash}` | `tutor.criado`, `tutor.atualizado`, `tutor.mesclado` |
| Contagem de tutores por tag | 300s | `tutor:tagcount:{tenantId}` | `tutor.tag.*` |

Busca (`GET /v1/tutors?q=`) **não** é cacheada: alta cardinalidade e necessidade de dado fresco no balcão.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "tutor_search_latency", "tenantId": "...", "value": 148, "unit": "ms" }
```

- `tutor_created_total`: cadastros por origem (balcão, portal, site, importação) — contínuo
- `tutor_duplicate_blocked_total` / `tutor_duplicate_override_total`: eficácia da deduplicação — diário
- `tutor_search_latency`: p95 da busca; alerta acima de 300ms
- `tutor_data_completeness_ratio`: % de cadastros COMPLETE — diário (qualidade da base do agente de IA)
- `tutor_whatsapp_optin_ratio`: % com opt-in ativo — diário (teto de alcance do CRM)
- `tutor_active_total` / `tutor_inactive_total`: saúde da carteira — diário
- `tutor_anonymized_total`: pedidos LGPD atendidos — mensal (relatório ao DPO)

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/tutors?q=` | 300ms | Tela de balcão com cliente presente |
| `GET /v1/tutors/:id` | 150ms | |
| `POST /v1/tutors` | 400ms | Inclui cifragem e verificação de duplicatas |
| `GET /v1/tutors/:id/overview` | 600ms | Agregação de 4 serviços via admin-bff |

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Limite de inatividade para a tag INATIVO — assumido 90 dias, configurável por tenant | MOD-CRM, MOD-TUTOR | PM | Antes da Fase 4 |
| 2 | Provedor de CEP (ViaCEP gratuito vs. serviço pago com SLA) e comportamento em indisponibilidade | MOD-TUTOR, MOD-TAXI | Tech Lead | Fase 1 |
| 3 | Geocodificação de endereço para roteirização do Taxi Dog — provedor e custo por consulta | MOD-TAXI | Tech Lead + PM | Antes da Fase 3 |
| 4 | Nome do tutor cifrado em repouso? Hoje em claro para viabilizar busca por similaridade | MOD-TUTOR, MOD-SEC | DPO + Tech Lead | Fase 7 |
| 5 | Merge reversível? Hoje o snapshot é guardado, mas não há rollback automatizado | MOD-TUTOR | PM | Pós-MVP |
| 6 | Importação CSV: quem responde pelo consentimento de base importada de outro sistema? | MOD-SEC, jurídico | DPO | Antes de habilitar importação |
