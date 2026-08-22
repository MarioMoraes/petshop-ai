# PRD Detalhado — Prontuário do Pet (Clínico e Comportamental)

**Módulo:** MOD-PRONT
**Arquivo:** 04/15
**Prioridade:** P0
**Fase de Implementação:** 2 — Prontuário e Financeiro
**Serviço Backend:** medical-record-service (porta 3004)
**Tabelas Principais:** attendances, attendance_items, attendance_notes, temperaments, allergies, medical_alerts, prescriptions, medical_attachments, vaccinations
**Data:** 2026-08-21
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O prontuário é o ativo de dados mais valioso do petshop e a principal barreira de saída do SaaS: um tenant migra de sistema quando o cadastro é simples, mas não migra quando tem três anos de histórico clínico e comportamental estruturado. Na operação diária, o prontuário resolve dois problemas concretos e caros: **segurança do profissional** (o banhista precisa saber, antes de abrir a caixa de transporte, que aquele pet morde) e **segurança do animal** (não usar shampoo ao qual ele é alérgico, não repetir procedimento contraindicado). Hoje isso vive na memória de um funcionário — e desaparece quando ele sai.

**Integração sistêmica.** Upstream: MOD-PET (pet e alertas), MOD-TUTOR (autorização de procedimento), MOD-AGENDA (o atendimento nasce de um agendamento e é concluído no check-out), MOD-IDENT (profissional responsável). Downstream: MOD-LEDGER (a conclusão do atendimento gera o débito), MOD-DOC (receituário e laudo em PDF), MOD-CRM (retorno de vacina, pós-atendimento), MOD-PORTAL (histórico resumido para o tutor), MOD-AI (triagem de sintomas alimentando o prontuário — item explícito do PRD §7.14).

**Escopo desta fase.** Inclui: registro de atendimento com itens executados, linha do tempo unificada por pet, temperamento estruturado, alergias e restrições com severidade e bloqueio operacional, alertas médicos, receituário e anexos de exames, registro de vacinas com data de retorno, e imutabilidade com janela de correção. Fica para fases posteriores: prontuário SOAP completo para clínica veterinária de maior porte, prescrição eletrônica assinada digitalmente (ICP-Brasil), integração com laboratórios e triagem automatizada por IA (Fase 8).

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-PRONT-01 | Registro de Atendimento | Todo serviço executado gera registro com profissional, data, itens e observações | Must Have |
| MOD-PRONT-02 | Linha do Tempo do Pet | Todos os eventos (serviços, vacinas, pesagens, alertas, fotos) em ordem cronológica | Must Have |
| MOD-PRONT-03 | Alergias e Restrições | Cadastro estruturado com severidade, que alerta e bloqueia serviços incompatíveis | Must Have |
| MOD-PRONT-04 | Temperamento | Classificação estruturada + observações, exibida antes de qualquer manuseio | Must Have |
| MOD-PRONT-05 | Alertas Médicos | Condições ativas (cardiopatia, epilepsia, idade avançada) visíveis na operação | Must Have |
| MOD-PRONT-06 | Anexos | Upload de exames, laudos e fotos clínicas (PDF/imagem) | Must Have |
| MOD-PRONT-07 | Receituário | Prescrição veterinária estruturada com geração de PDF | Should Have |
| MOD-PRONT-08 | Vacinas | Registro de vacina com lote, validade e data de retorno | Should Have |
| MOD-PRONT-09 | Imutabilidade e Correção | Registro imutável após janela de 24h; correção posterior gera adendo versionado | Must Have |
| MOD-PRONT-10 | Observações Operacionais | Notas rápidas do banhista/tosador durante a execução, com foto antes/depois | Must Have |
| MOD-PRONT-11 | Resumo Clínico | Sumário do pet (alertas, últimas ocorrências, vacinas em dia) para consumo pela IA | Should Have |

## 3. Critérios de Aceite

### [MOD-PRONT-01] — Registro de Atendimento

**AC-01 (Happy Path)**
- **Dado** um agendamento em `IN_PROGRESS` com check-in feito
- **Quando** o profissional conclui via `POST /v1/attendances` com `{ appointmentId, petId, type: "GROOMING", items: [{ serviceId, executedBy, notes }], observations, weightKg }`
- **Então** o atendimento é criado com `status = COMPLETED`, a pesagem é enviada ao MOD-PET, o agendamento vai para `COMPLETED`, publica-se `atendimento.concluido` (que dispara o débito no MOD-LEDGER) e retorna **201**

**AC-02 (Validação / Erro)**
- **Dado** um `appointmentId` inexistente, de outro tenant ou já concluído
- **Quando** o atendimento é registrado
- **Então** retorna **404** `ERR_PRONT_001` ou **409** `ERR_PRONT_004` "Este agendamento já possui atendimento registrado"

**AC-03 (Edge Case — atendimento sem agendamento)**
- **Dado** um cliente de encaixe que chegou sem agendamento
- **Quando** o atendimento é criado com `appointmentId = null` e `origin: "WALK_IN"`
- **Então** o registro é aceito (**201**), um agendamento retroativo é criado automaticamente para manter a agenda consistente, e o débito é gerado normalmente

**AC-04 (Edge Case — profissional executa serviço não habilitado)**
- **Dado** um banhista registrando um item do tipo "consulta veterinária"
- **Quando** submete
- **Então** retorna **403** `ERR_PRONT_003` "Este profissional não está habilitado a executar este serviço"

### [MOD-PRONT-03] — Alergias e Restrições

**AC-01 (Happy Path)**
- **Dado** um veterinário na ficha do pet
- **Quando** cria `POST /v1/pets/:petId/allergies` com `{ type: "PRODUCT", label: "Shampoo neutro marca X", severity: "HIGH", blocksServices: [serviceId1], reaction: "Dermatite severa", diagnosedAt }`
- **Então** a alergia é criada com `active = true`, publica-se `prontuario.alerta.alterado` (invalidando o cache do pet), e o alerta passa a aparecer na agenda, no check-in e na tela de execução

**AC-02 (Bloqueio no agendamento)**
- **Dado** um pet com alergia `severity = CRITICAL` que bloqueia o serviço "Banho com shampoo X"
- **Quando** alguém tenta agendar exatamente esse serviço
- **Então** retorna **409** `ERR_PRONT_005` "Serviço incompatível com alergia registrada (Shampoo X — CRÍTICA)"; a operação só prossegue com override de `TENANT_ADMIN` ou `VET`, com justificativa obrigatória registrada em auditoria

**AC-03 (Edge Case — severidade média)**
- **Dado** um pet com alergia `severity = MEDIUM`
- **Quando** o serviço relacionado é agendado
- **Então** o sistema **permite**, mas retorna `warnings[]` e exige `acknowledged = true` no payload — o alerta é exibido em destaque no check-in e na comanda impressa

**AC-04 (Edge Case — alergia resolvida)**
- **Dado** uma alergia que se mostrou incorreta após reavaliação
- **Quando** o veterinário a desativa com `PATCH .../allergies/:id { active: false, resolutionNotes }`
- **Então** ela sai dos alertas ativos mas **permanece no histórico** com data e responsável pela desativação — nunca é apagada

### [MOD-PRONT-04] — Temperamento

**AC-01 (Happy Path)**
- **Dado** um banhista que atendeu o pet
- **Quando** registra `POST /v1/pets/:petId/temperament` com `{ classification: "REACTIVE", contexts: ["NAIL_TRIMMING","DRYER"], notes: "Precisa de focinheira para corte de unhas", requiresMuzzle: true, requiresTwoHandlers: false }`
- **Então** o registro entra no histórico, o temperamento vigente do pet é atualizado e o alerta aparece com destaque visual em toda tela operacional

**AC-02 (Validação / Erro)**
- **Dado** `classification = "AGGRESSIVE"` sem `notes` preenchido
- **Quando** submetido
- **Então** retorna **422** `ERR_PRONT_002` "Descreva o contexto da agressividade — a equipe precisa saber o que evitar"

**AC-03 (Edge Case — evolução do temperamento)**
- **Dado** um pet classificado como `AGGRESSIVE` há 2 anos e como `DOCILE` nos últimos 5 atendimentos
- **Quando** a ficha é consultada
- **Então** exibe-se o temperamento **mais recente** como vigente, com badge "Histórico: já apresentou reatividade" e link para a linha do tempo — histórico de risco nunca desaparece silenciosamente

**AC-04 (Edge Case — alerta obrigatório no check-in)**
- **Dado** um pet com `requiresMuzzle = true`
- **Quando** o check-in é realizado
- **Então** a tela exige confirmação explícita ("Ciente: pet requer focinheira") antes de concluir o check-in, e a confirmação é auditada

### [MOD-PRONT-02] — Linha do Tempo

**AC-01 (Happy Path)**
- **Dado** um pet com 40 eventos ao longo de 2 anos
- **Quando** o usuário chama `GET /v1/pets/:petId/timeline?limit=20`
- **Então** retorna eventos unificados (atendimentos, vacinas, pesagens, alergias, alertas, fotos, transferências) ordenados por data desc, com paginação por cursor, em menos de 500ms

**AC-02 (Filtro por tipo e permissão)**
- **Dado** um usuário `BATHER`
- **Quando** consulta a linha do tempo
- **Então** vê apenas eventos operacionais (serviços, observações, alertas), **sem** laudos, prescrições e diagnósticos clínicos — filtrados no servidor, jamais apenas na UI

**AC-03 (Edge Case — pet transferido)**
- **Dado** um pet transferido entre tutores
- **Quando** o **tutor atual** consulta a linha do tempo pelo Portal
- **Então** vê o histórico clínico completo do pet (ele é o responsável atual pela saúde do animal), mas **não** vê valores pagos pelo tutor anterior

### [MOD-PRONT-09] — Imutabilidade e Correção

**AC-01 (Happy Path — janela de edição)**
- **Dado** um atendimento registrado há 40 minutos pelo mesmo profissional
- **Quando** ele corrige uma observação
- **Então** a edição é aplicada diretamente (dentro da janela de 24h), com registro do diff em auditoria

**AC-02 (Validação / Erro — fora da janela)**
- **Dado** um atendimento registrado há 3 dias
- **Quando** alguém tenta editá-lo
- **Então** retorna **409** `ERR_PRONT_006` "Registros com mais de 24h não podem ser editados. Adicione um adendo."; `POST /v1/attendances/:id/addendum` cria adendo versionado, visível na linha do tempo abaixo do registro original

**AC-03 (Edge Case — exclusão)**
- **Dado** um atendimento registrado por engano no pet errado
- **Quando** o admin solicita anulação
- **Então** o registro **não é excluído**: vai para `status = VOIDED` com motivo obrigatório, aparece riscado na linha do tempo, o débito correspondente é estornado por lançamento de contrapartida no ledger (nunca por edição), e um novo registro é criado no pet correto

### [MOD-PRONT-08] — Vacinas

**AC-01 (Happy Path)**
- **Dado** um veterinário aplicando vacina
- **Quando** registra `{ vaccineType: "V10", manufacturer, batch, expiresAt, appliedAt, nextDoseAt }`
- **Então** o registro entra no prontuário, publica-se `vacina.aplicada` e o MOD-CRM agenda o lembrete de retorno para `nextDoseAt - 7 dias`

**AC-02 (Validação / Erro)**
- **Dado** um lote com validade anterior à data de aplicação
- **Quando** submetido
- **Então** retorna **422** `ERR_PRONT_002` "O lote informado está vencido na data de aplicação"

**AC-03 (Edge Case — vacina atrasada)**
- **Dado** um pet com `nextDoseAt` vencido há 45 dias
- **Quando** a ficha é consultada ou um serviço é agendado
- **Então** exibe-se o alerta "Vacinação atrasada (V10, vencida há 45 dias)"; se o tenant configurou `requireVaccinationForServices = true`, o agendamento de creche/hotel é bloqueado com **409** `ERR_PRONT_007`

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| attendances | id | UUID | ✓ | PK |
| attendances | tenant_id | UUID | ✓ | Isolamento multi-tenant (RLS) |
| attendances | pet_id | UUID | ✓ | FK pets |
| attendances | tutor_id | UUID | ✓ | Responsável no momento do atendimento (snapshot) |
| attendances | appointment_id | UUID | — | FK appointments; nulo em walk-in |
| attendances | type | Enum | ✓ | GROOMING, BATH, VET_CONSULT, VACCINE, PROCEDURE, DAYCARE, OTHER |
| attendances | origin | Enum | ✓ | SCHEDULED, WALK_IN, RETROACTIVE |
| attendances | performed_by | UUID | ✓ | Profissional responsável |
| attendances | started_at / finished_at | Timestamptz | ✓ | Duração real do serviço |
| attendances | observations | Text | — | Observações gerais |
| attendances | weight_kg | Decimal(5,2) | — | Pesagem do dia |
| attendances | status | Enum | ✓ | DRAFT, COMPLETED, VOIDED |
| attendances | void_reason | Text | — | Obrigatório se VOIDED |
| attendances | editable_until | Timestamptz | ✓ | `finished_at + 24h` |
| attendances | version | Int | ✓ | Incrementa a cada adendo |
| attendances | created_by / created_at / updated_at | — | ✓ | Auditoria |
| attendance_items | id / tenant_id / attendance_id | UUID | ✓ | PK e FKs |
| attendance_items | service_id | UUID | ✓ | FK services (MOD-AGENDA) |
| attendance_items | executed_by | UUID | ✓ | Quem executou este item |
| attendance_items | unit_price / quantity / total_price | Decimal(10,2)/Int | ✓ | Snapshot de preço (imutável) |
| attendance_items | notes | Text | — | Observação do item |
| attendance_items | products_used | JSONB | — | `[{ name, batch }]` — rastreio de produto em alergia |
| attendance_notes | id / tenant_id / attendance_id | UUID | ✓ | PK e FKs — adendos |
| attendance_notes | body | Text | ✓ | Conteúdo do adendo |
| attendance_notes | visibility | Enum | ✓ | INTERNAL, TUTOR_VISIBLE |
| attendance_notes | author_id / created_at | — | ✓ | Append-only |
| allergies | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| allergies | type | Enum | ✓ | FOOD, PRODUCT, MEDICATION, ENVIRONMENTAL, OTHER |
| allergies | label | String(120) | ✓ | Substância/produto |
| allergies | severity | Enum | ✓ | LOW, MEDIUM, HIGH, CRITICAL |
| allergies | reaction | Text | — | Reação observada |
| allergies | blocks_services | UUID[] | — | Serviços bloqueados |
| allergies | blocks_products | Text[] | — | Palavras-chave de produto bloqueado |
| allergies | diagnosed_at / diagnosed_by | Date / UUID | ✓/— | Origem do diagnóstico |
| allergies | active | Boolean | ✓ | Desativação preserva histórico |
| allergies | resolution_notes / deactivated_by / deactivated_at | — | — | Motivo da desativação |
| temperaments | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| temperaments | classification | Enum | ✓ | DOCILE, ANXIOUS, FEARFUL, REACTIVE, AGGRESSIVE, UNKNOWN |
| temperaments | contexts | Text[] | — | NAIL_TRIMMING, DRYER, MUZZLE, BATH, STRANGERS, OTHER_DOGS |
| temperaments | requires_muzzle | Boolean | ✓ | Alerta operacional |
| temperaments | requires_two_handlers | Boolean | ✓ | Alerta operacional |
| temperaments | notes | Text | ✓ se AGGRESSIVE/REACTIVE | Contexto obrigatório |
| temperaments | observed_by / observed_at | UUID / Timestamptz | ✓ | Quem observou |
| temperaments | is_current | Boolean | ✓ | Apenas um vigente por pet |
| medical_alerts | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| medical_alerts | condition | String(120) | ✓ | Cardiopatia, epilepsia, diabetes |
| medical_alerts | severity | Enum | ✓ | LOW, MEDIUM, HIGH, CRITICAL |
| medical_alerts | instructions | Text | — | "Não usar secador quente" |
| medical_alerts | active / created_by / created_at | — | ✓ | |
| prescriptions | id / tenant_id / pet_id / attendance_id | UUID | ✓ | PK e FKs |
| prescriptions | vet_id | UUID | ✓ | Veterinário prescritor |
| prescriptions | crmv | String(20) | ✓ | Registro profissional (snapshot) |
| prescriptions | items | JSONB | ✓ | `[{ drug, concentration, dosage, frequency, durationDays }]` |
| prescriptions | instructions | Text | — | Orientações ao tutor |
| prescriptions | document_id | UUID | — | PDF gerado (MOD-DOC) |
| prescriptions | issued_at | Timestamptz | ✓ | Imutável após emissão |
| medical_attachments | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| medical_attachments | attendance_id | UUID | — | Vínculo opcional |
| medical_attachments | type | Enum | ✓ | EXAM, REPORT, XRAY, PHOTO, OTHER |
| medical_attachments | file_url / mime_type / size_bytes | — | ✓ | Storage Cloudflare R2 |
| medical_attachments | title / description | String / Text | ✓/— | Identificação |
| medical_attachments | uploaded_by / created_at / deleted_at | — | ✓ | Auditoria e soft delete |
| vaccinations | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| vaccinations | vaccine_type | String(60) | ✓ | V8, V10, antirrábica, gripe |
| vaccinations | manufacturer / batch | String | ✓ | Rastreabilidade sanitária |
| vaccinations | batch_expires_at | Date | ✓ | Validade do lote |
| vaccinations | applied_at | Timestamptz | ✓ | Aplicação |
| vaccinations | next_dose_at | Date | — | Base do lembrete de retorno |
| vaccinations | applied_by / crmv | UUID / String | ✓ | Responsável técnico |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| observations | attendances | Pode conter dado sensível do tutor ("tutora relatou internação") |
| notes | temperaments | Registro comportamental com potencial impacto reputacional |
| reaction | allergies | Dado de saúde do animal com detalhe clínico |
| items, instructions | prescriptions | Dado clínico de prescrição |
| description, title | medical_attachments | Metadado de laudo |

> Dado de saúde **animal** não é dado pessoal sensível na LGPD (art. 5º, II trata de pessoa natural). Ainda assim, o conjunto prontuário + tutor identificado é dado pessoal por associação, e o sigilo profissional veterinário (Res. CFMV 1.138/2016) exige confidencialidade. A cifragem aqui é decisão de produto, não obrigação legal direta.

### Índices Necessários

```sql
CREATE INDEX idx_attendances_tenant_pet ON attendances(tenant_id, pet_id, started_at DESC);
CREATE INDEX idx_attendances_tenant_date ON attendances(tenant_id, started_at DESC) WHERE status = 'COMPLETED';
CREATE UNIQUE INDEX idx_attendances_appointment ON attendances(appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'VOIDED';
CREATE INDEX idx_attendances_professional ON attendances(tenant_id, performed_by, started_at DESC);

CREATE INDEX idx_allergies_pet_active ON allergies(pet_id) WHERE active;
CREATE INDEX idx_allergies_blocks ON allergies USING GIN(blocks_services) WHERE active;

CREATE UNIQUE INDEX idx_temperament_current ON temperaments(pet_id) WHERE is_current;
CREATE INDEX idx_temperament_pet_history ON temperaments(pet_id, observed_at DESC);

CREATE INDEX idx_medical_alerts_pet ON medical_alerts(pet_id) WHERE active;
CREATE INDEX idx_vaccinations_pet ON vaccinations(pet_id, applied_at DESC);
CREATE INDEX idx_vaccinations_next_dose ON vaccinations(tenant_id, next_dose_at) WHERE next_dose_at IS NOT NULL;
CREATE INDEX idx_attachments_pet ON medical_attachments(pet_id, created_at DESC) WHERE deleted_at IS NULL;
```

Imutabilidade reforçada no banco:

```sql
CREATE OR REPLACE FUNCTION prevent_attendance_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND now() > OLD.editable_until
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'ERR_PRONT_006: atendimento imutável após 24h — use adendo';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

## 5. Contratos de API

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/pets/:petId/timeline | ADMIN, RECEPTIONIST, VET, GROOMER, BATHER (filtrado), TUTOR (resumo) | Linha do tempo unificada (cursor) |
| GET | /v1/pets/:petId/summary | ADMIN, VET, RECEPTIONIST, agente IA | Resumo clínico estruturado |
| GET | /v1/attendances | ADMIN, RECEPTIONIST, VET | Listar (filtros: `petId`, `professionalId`, `from`, `to`, `type`) |
| POST | /v1/attendances | ADMIN, VET, GROOMER, BATHER, RECEPTIONIST | Registrar atendimento |
| GET | /v1/attendances/:id | ADMIN, RECEPTIONIST, VET, executor | Detalhe |
| PATCH | /v1/attendances/:id | Autor (≤24h), ADMIN | Editar dentro da janela |
| POST | /v1/attendances/:id/addendum | ADMIN, VET, autor | Adicionar adendo |
| POST | /v1/attendances/:id/void | ADMIN | Anular com motivo |
| GET | /v1/pets/:petId/allergies | Todos os operacionais | Listar alergias |
| POST | /v1/pets/:petId/allergies | ADMIN, VET, RECEPTIONIST | Criar alergia |
| PATCH | /v1/pets/:petId/allergies/:id | ADMIN, VET | Atualizar/desativar |
| GET | /v1/pets/:petId/temperament | Todos os operacionais | Vigente + histórico |
| POST | /v1/pets/:petId/temperament | ADMIN, VET, GROOMER, BATHER | Registrar observação |
| GET/POST | /v1/pets/:petId/medical-alerts | ADMIN, VET (POST) / operacionais (GET) | Alertas médicos |
| GET/POST | /v1/pets/:petId/vaccinations | ADMIN, VET, RECEPTIONIST | Vacinas |
| GET/POST | /v1/pets/:petId/attachments | ADMIN, VET, RECEPTIONIST | Anexos |
| POST | /v1/attendances/:id/prescriptions | VET | Emitir receituário |
| GET | /v1/prescriptions/:id/pdf | ADMIN, VET, TUTOR (próprio) | PDF via MOD-DOC |
| POST | /v1/pets/:petId/allergy-check | Interno + ADMIN, RECEPTIONIST | Verificar compatibilidade serviço x alergia |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const SeveritySchema = z.enum(['LOW','MEDIUM','HIGH','CRITICAL'])

export const CreateAttendanceSchema = z.object({
  petId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  type: z.enum(['GROOMING','BATH','VET_CONSULT','VACCINE','PROCEDURE','DAYCARE','OTHER']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  observations: z.string().max(4000).optional(),
  weightKg: z.number().min(0.05).max(120).optional(),
  items: z.array(z.object({
    serviceId: z.string().uuid(),
    executedBy: z.string().uuid(),
    quantity: z.number().int().min(1).default(1),
    unitPrice: z.number().min(0),
    notes: z.string().max(500).optional(),
    productsUsed: z.array(z.object({ name: z.string(), batch: z.string().optional() })).optional(),
  })).min(1),
  allergyAcknowledged: z.boolean().default(false),
}).refine(d => new Date(d.finishedAt) > new Date(d.startedAt), {
  message: 'Término deve ser posterior ao início', path: ['finishedAt'],
})

export const CreateAllergySchema = z.object({
  type: z.enum(['FOOD','PRODUCT','MEDICATION','ENVIRONMENTAL','OTHER']),
  label: z.string().min(2).max(120),
  severity: SeveritySchema,
  reaction: z.string().max(1000).optional(),
  blocksServices: z.array(z.string().uuid()).default([]),
  blocksProducts: z.array(z.string().max(80)).default([]),
  diagnosedAt: z.string().date(),
})

export const CreateTemperamentSchema = z.object({
  classification: z.enum(['DOCILE','ANXIOUS','FEARFUL','REACTIVE','AGGRESSIVE','UNKNOWN']),
  contexts: z.array(z.enum(['NAIL_TRIMMING','DRYER','MUZZLE','BATH','STRANGERS','OTHER_DOGS','HANDLING'])).default([]),
  requiresMuzzle: z.boolean().default(false),
  requiresTwoHandlers: z.boolean().default(false),
  notes: z.string().max(1000).optional(),
}).refine(d => !['AGGRESSIVE','REACTIVE'].includes(d.classification) || !!d.notes, {
  message: 'Descreva o contexto para classificações de risco', path: ['notes'],
})

// Contrato consumido pela agenda e, futuramente, pelo agente de IA
export const PetClinicalSummarySchema = z.object({
  petId: z.string().uuid(),
  activeAllergies: z.array(z.object({ label: z.string(), severity: SeveritySchema, type: z.string() })),
  currentTemperament: z.object({
    classification: z.string(), requiresMuzzle: z.boolean(),
    requiresTwoHandlers: z.boolean(), contexts: z.array(z.string()),
  }).nullable(),
  activeMedicalAlerts: z.array(z.object({ condition: z.string(), severity: SeveritySchema, instructions: z.string().nullable() })),
  vaccinationStatus: z.enum(['UP_TO_DATE','DUE_SOON','OVERDUE','UNKNOWN']),
  lastAttendanceAt: z.string().datetime().nullable(),
  attendanceCount12m: z.number().int(),
  blockingFlags: z.array(z.string()),   // ex.: ["ALLERGY_CRITICAL","VACCINATION_OVERDUE"]
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_PRONT_001 | 404 | Registro não encontrado neste tenant |
| ERR_PRONT_002 | 422 | Dados inválidos (datas, lote vencido, notas obrigatórias) |
| ERR_PRONT_003 | 403 | Papel sem permissão clínica ou profissional não habilitado |
| ERR_PRONT_004 | 409 | Atendimento já registrado para este agendamento |
| ERR_PRONT_005 | 409 | Serviço incompatível com alergia CRÍTICA |
| ERR_PRONT_006 | 409 | Registro imutável (fora da janela de 24h) |
| ERR_PRONT_007 | 409 | Vacinação obrigatória pendente para este serviço |
| ERR_PRONT_008 | 422 | Anexo inválido (formato/tamanho) |
| ERR_PRONT_009 | 403 | Prescrição exige veterinário com CRMV cadastrado |

## 6. Máquinas de Estado

### Atendimento — Status

```
DRAFT ──(conclusão do serviço)──► COMPLETED ──(≤24h)──► COMPLETED (editável)
  │                                    │
  │                                    ├─(>24h)──► COMPLETED (imutável, só adendo)
  │                                    │
  └─(descarte)──► (excluído)           └─(anulação por ADMIN + motivo)──► VOIDED (terminal)
```

### Alergia / Alerta Médico

```
ACTIVE ──(reavaliação clínica com justificativa)──► INACTIVE (permanece no histórico, nunca apagado)
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| DRAFT | COMPLETED | `atendimento.concluido` | Débito no ledger; pós-atendimento ao tutor (WhatsApp); foto do resultado | ✓ |
| COMPLETED | VOIDED | `atendimento.anulado` | Estorno no ledger (lançamento de contrapartida) | ✓ |
| — | Alergia ACTIVE | `prontuario.alerta.alterado` | Invalidação de cache do pet; revalidação de agendamentos futuros | ✓ |
| — | Vacina aplicada | `vacina.aplicada` | Agendamento do lembrete de retorno (MOD-CRM) | ✓ |
| — | Prescrição emitida | `prescricao.emitida` | Geração de PDF e envio ao tutor | ✓ |

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Todo serviço gera prontuário | Nenhum atendimento é concluído sem registro — requisito do PRD §7.3 | MOD-AGENDA, MOD-PRONT |
| RN-02 | Alerta obrigatório na agenda | Toda tela de agendamento e check-in exibe alergias e temperamento do pet | MOD-AGENDA, MOD-PORTAL |
| RN-03 | Alergia CRITICAL bloqueia | Bloqueio suave: só passa com override de ADMIN/VET e justificativa auditada | MOD-AGENDA |
| RN-04 | Alergia MEDIUM/HIGH alerta | Exige `acknowledged = true` no payload; a UI mostra modal de confirmação | MOD-AGENDA |
| RN-05 | Imutabilidade após 24h | Correção vira adendo versionado; registro original nunca é sobrescrito | MOD-ADMIN (auditoria) |
| RN-06 | Anulação, nunca exclusão | `VOIDED` + estorno por contrapartida no ledger | MOD-LEDGER |
| RN-07 | Preço é snapshot | `attendance_items` guarda o preço praticado; alteração futura da tabela não altera histórico | MOD-LEDGER |
| RN-08 | Visibilidade por papel | Banhista/tosador veem alertas de segurança, não diagnósticos; recepção vê resumo; veterinário vê tudo | MOD-IDENT |
| RN-09 | Tutor vê resumo | Portal exibe serviços, vacinas, receituário e fotos — não observações internas (`visibility = INTERNAL`) | MOD-PORTAL |
| RN-10 | Prescrição exige CRMV | Bloqueio se o veterinário não tiver CRMV cadastrado; o número entra como snapshot na prescrição | MOD-IDENT, MOD-DOC |
| RN-11 | Produtos usados | Registrar produto e lote permite rastrear a origem de uma reação alérgica futura | MOD-PRONT |
| RN-12 | Vacina vencida bloqueia | Apenas quando `requireVaccinationForServices = true` e para serviços de convívio (creche, hotel) | MOD-AGENDA, MOD-IDENT |
| RN-13 | Concorrência no registro | Índice único em `appointment_id` impede dois atendimentos para o mesmo agendamento em corrida | MOD-AGENDA |
| RN-14 | Prontuário segue o pet | Transferência de tutor não move nem oculta o histórico clínico | MOD-PET |
| RN-15 | Temperamento vigente único | Novo registro rebaixa o anterior (`is_current = false`) na mesma transação | MOD-PRONT |
| RN-16 | Histórico de risco é permanente | Mesmo com temperamento atual dócil, exibe-se badge de reatividade anterior | MOD-PRONT, MOD-AGENDA |

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `atendimento.concluido` | medical-record-service | billing-ledger (débito), tutor (last_attendance_at), pet (peso), crm-automation, audit | `{ tenantId, attendanceId, petId, tutorId, items[], totalAmount, performedBy, finishedAt }` |
| `atendimento.anulado` | medical-record-service | billing-ledger (estorno), crm-automation, audit | `{ tenantId, attendanceId, reason, voidedBy, timestamp }` |
| `prontuario.alerta.alterado` | medical-record-service | pet (cache), scheduling (revalida futuros), portal-bff, audit | `{ tenantId, petId, alertType, severity, active, timestamp }` |
| `vacina.aplicada` | medical-record-service | crm-automation (lembrete de retorno), notification, audit | `{ tenantId, petId, tutorId, vaccineType, nextDoseAt, timestamp }` |
| `prescricao.emitida` | medical-record-service | document-service (PDF), notification, audit | `{ tenantId, prescriptionId, petId, tutorId, vetId, timestamp }` |
| `prontuario.anexo.adicionado` | medical-record-service | portal-bff, audit | `{ tenantId, petId, attachmentId, type, timestamp }` |

Consome: `agendamento.checkin` (abre atendimento em DRAFT), `pet.obito` (encerra alertas ativos), `pet.transferido` (registra evento na linha do tempo).

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Ver linha do tempo completa | — | ✓ | resumo | operacional | ✓ | — | resumo |
| Ver alergias/temperamento | — | ✓ | ✓ | ✓ | ✓ | ✓ (básico) | ✓ (próprio) |
| Registrar atendimento | — | ✓ | ✓ | ✓ (próprios itens) | ✓ | — | — |
| Editar (≤24h) | — | ✓ | autor | autor | autor | — | — |
| Adendo | — | ✓ | — | autor | ✓ | — | — |
| Anular atendimento | — | ✓ | — | — | — | — | — |
| Criar/editar alergia | — | ✓ | ✓ (criar) | — | ✓ | — | solicita |
| Desativar alergia | — | ✓ | — | — | ✓ | — | — |
| Registrar temperamento | — | ✓ | ✓ | ✓ | ✓ | — | — |
| Ver diagnóstico/laudo | — | ✓ | — | — | ✓ | — | ✓ (próprio) |
| Emitir prescrição | — | — | — | — | ✓ | — | — |
| Anexar exame | — | ✓ | ✓ | — | ✓ | — | ✓ (próprio) |

> Super Admin **não** acessa prontuário — restrição explícita do PRD §5 ("sem acesso indevido aos dados de negócio dos tenants"). Suporte em caso de bug se dá por logs anonimizados, nunca pelo conteúdo clínico.

### Audit Log — ações que DEVEM gerar registro imutável

- `attendance.created`, `attendance.updated` (diff), `attendance.voided` (motivo obrigatório), `attendance.addendum_added`
- `allergy.created`, `allergy.deactivated` (justificativa), `allergy.override_used` — **quem autorizou serviço apesar do bloqueio**
- `temperament.recorded`
- `prescription.issued`
- `medical_record.viewed` — **toda leitura de prontuário completo** (sigilo profissional; log de acesso, não apenas de escrita)
- `attachment.uploaded`, `attachment.deleted`

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| Registros de atendimento | Dado pessoal por associação | Execução de contrato | 5 anos após último atendimento | ✓ | — (retenção técnica/legal) |
| Prescrições | Dado clínico + registro profissional | Obrigação legal (CFMV) | 5 anos (Res. CFMV) | ✓ | — |
| Anexos (exames/laudos) | Dado clínico | Execução de contrato | 5 anos | ✓ | ✓ após retenção |
| observations (livre) | Pode conter dado do tutor | Legítimo interesse | 5 anos | ✓ | ✓ (redação do trecho) |
| Alergias e temperamento | Dado do animal | Execução de contrato + segurança | Vida do pet + 5 anos | ✓ | — |

> Na anonimização do tutor (MOD-TUTOR), o prontuário do pet é **preservado** e desvinculado: `attendances.tutor_id` aponta para o registro anonimizado, e nenhum dado pessoal do tutor sobrevive nos campos livres (varredura e redação no processo de anonimização).

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Resumo clínico do pet | 300s | `pront:summary:{tenantId}:{petId}` | `prontuario.alerta.alterado`, `atendimento.concluido`, `vacina.aplicada` |
| Alertas ativos (agenda) | 600s | `pront:alerts:{tenantId}:{petId}` | Qualquer alteração de alergia/temperamento/alerta |
| Primeira página da timeline | 120s | `pront:timeline:{tenantId}:{petId}:p1` | Novo evento no pet |
| Verificação serviço x alergia | 600s | `pront:allergycheck:{tenantId}:{petId}:{serviceId}` | `prontuario.alerta.alterado` |

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "attendance_duration_variance", "tenantId": "...", "value": 18, "unit": "percent" }
```

- `attendance_created_total`: atendimentos por tipo, profissional e origem — contínuo
- `attendance_duration_variance`: desvio entre duração estimada e real — semanal (calibra a agenda)
- `attendance_voided_total`: anulações; pico indica erro de processo ou treinamento
- `allergy_block_triggered_total` e `allergy_override_total`: **override frequente é sinal de alerta mal cadastrado ou de risco assumido** — revisão semanal
- `temperament_risk_pets_total`: pets com `requiresMuzzle` ou classificação de risco — mensal (segurança do trabalho)
- `vaccination_overdue_total`: pets com vacina atrasada — diário (oportunidade de receita e de compliance)
- `medical_record_view_total`: acessos ao prontuário por papel — auditoria contínua
- `timeline_latency_ms`: p95 da linha do tempo; alerta acima de 500ms

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/pets/:id/summary` | 150ms | Consumido pela agenda a cada abertura de ficha |
| `GET /v1/pets/:id/timeline` | 500ms | Paginação por cursor |
| `POST /v1/attendances` | 600ms | Transação com múltiplos itens + publicação de evento |
| `POST /v1/pets/:id/allergy-check` | 80ms | Chamado na validação de agendamento |

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Janela de edição de 24h — validar com veterinários se é suficiente para a rotina clínica | MOD-PRONT, UX | PM + veterinário consultor | Fase 2 |
| 2 | Prescrição eletrônica com assinatura ICP-Brasil (exigência crescente para receita de controlados) | MOD-DOC, jurídico | PM + Tech Lead | Pós-MVP |
| 3 | Prontuário SOAP completo para clínicas maiores — v1 entrega modelo simplificado | MOD-PRONT, segmentação de plano | PM | Fase 2+ |
| 4 | Retenção de prontuário: 5 anos (Res. CFMV) vs. vida do animal | MOD-SEC, custo de storage | DPO + jurídico | Fase 7 |
| 5 | Bloqueio de serviço por vacina vencida deve ser padrão ligado ou desligado? Assumido **desligado** | MOD-AGENDA, atrito comercial | PM | Fase 3 |
| 6 | Triagem por IA escrevendo no prontuário (PRD §7.14): registro entra como DRAFT para validação humana? | MOD-AI, responsabilidade técnica | PM + Tech Lead | Fase 8 |
