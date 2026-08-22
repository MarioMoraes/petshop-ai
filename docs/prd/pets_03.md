# PRD Detalhado — Cadastro de Pets e Tabelas de Domínio

**Módulo:** MOD-PET
**Arquivo:** 03/15
**Prioridade:** P0
**Fase de Implementação:** 1 — Cadastros Core
**Serviço Backend:** pet-service (porta 3003)
**Tabelas Principais:** pets, pet_tutors, species, breeds, sizes, coats, pet_photos, pet_transfer_log
**Data:** 2026-08-21
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O pet é o "paciente" e a unidade em torno da qual gira toda a operação: a agenda é do pet, o prontuário é do pet, o preço do banho depende do porte e da pelagem do pet. Quando raça e porte são texto livre ("SRD", "vira-lata", "sem raça definida" para o mesmo animal), o petshop perde a capacidade de precificar corretamente, de montar relatórios e — o que mais importa no roadmap — de dar contexto estruturado ao agente de IA. Este módulo garante que espécie, raça, porte e pelagem sejam **cadastros estruturados**, e que a foto do pet exista, porque é o que o tutor quer ver no portal e o que a equipe usa para conferir o animal na entrega.

**Integração sistêmica.** Upstream: MOD-IDENT (tenant) e MOD-TUTOR (vínculo N:N). Downstream: MOD-PRONT (prontuário é por pet), MOD-AGENDA (duração e preço do serviço variam por porte/pelagem; alertas de alergia e temperamento aparecem no agendamento), MOD-TAXI (porte define o veículo), MOD-CRM (aniversário do pet, campanhas por espécie), MOD-PORTAL (tutor vê e edita seus pets), MOD-DOC (dados do pet em receituários e termos), MOD-AI (o agente precisa saber que "o Thor" é o labrador de 32 kg da Maria).

**Escopo desta fase.** Inclui: CRUD de pet com atributos estruturados, vínculo N:N com tutores e papéis (principal/secundário), catálogo global de espécies e raças com extensão por tenant, álbum de fotos com upload para Cloudflare Images, transferência de titularidade preservando histórico, cálculo de idade, registro de óbito e histórico de peso. Fica para fases posteriores: reconhecimento automático de raça por foto, carteira de vacinação com calendário próprio (v1 trata vacina como atendimento no prontuário), e integração com bases oficiais de microchip.

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-PET-01 | CRUD de Pet | Criar, ler, atualizar e desativar pet com atributos estruturados | Must Have |
| MOD-PET-02 | Vínculo N:N Pet↔Tutor | Múltiplos tutores por pet, com um responsável principal | Must Have |
| MOD-PET-03 | Tabelas de Domínio | Espécie, raça, porte e pelagem — catálogo global + extensões do tenant | Must Have |
| MOD-PET-04 | Álbum de Fotos | Upload múltiplo, galeria cronológica, foto de capa, via Cloudflare Images | Must Have |
| MOD-PET-05 | Transferência de Titularidade | Mudar responsável mantendo histórico completo (adoção, venda, falecimento do tutor) | Must Have |
| MOD-PET-06 | Idade e Faixa Etária | Cálculo automático a partir da data de nascimento ou idade estimada | Must Have |
| MOD-PET-07 | Histórico de Peso | Série temporal de pesagens, base para dosagem clínica e relatórios | Should Have |
| MOD-PET-08 | Status do Pet e Óbito | Ativo, inativo e falecido — com supressão imediata de campanhas | Must Have |
| MOD-PET-09 | Microchip | Registro e validação de formato, único por tenant | Should Have |
| MOD-PET-10 | Busca de Pets | Busca por nome do pet, tutor, raça e microchip | Must Have |
| MOD-PET-11 | Ficha para Impressão | Ficha resumida do pet para uso na sala de banho e tosa | Nice to Have |

## 3. Critérios de Aceite

### [MOD-PET-01] — CRUD de Pet

**AC-01 (Happy Path)**
- **Dado** um `RECEPTIONIST` autenticado e um tutor existente
- **Quando** envia `POST /v1/pets` com `{ name: "Thor", speciesId, breedId, sizeId, coatId, sex: "MALE", birthDate: "2021-03-10", weightKg: 32.4, neutered: true, tutors: [{ tutorId, role: "PRIMARY" }] }`
- **Então** o pet é criado com `status = ACTIVE`, o vínculo com o tutor é criado, a primeira pesagem é registrada no histórico, publica-se `pet.criado` e retorna **201** com `ageMonths` calculado

**AC-02 (Validação / Erro)**
- **Dado** um `breedId` que pertence a outra espécie (raça de gato com espécie cão)
- **Quando** o cadastro é submetido
- **Então** retorna **422** `ERR_PET_002` "A raça selecionada não pertence à espécie informada"

**AC-03 (Edge Case — idade desconhecida)**
- **Dado** um pet resgatado sem data de nascimento
- **Quando** o cadastro informa `estimatedAgeMonths: 24` em vez de `birthDate`
- **Então** o sistema deriva `birth_date_estimated = hoje - 24 meses` com `birth_date_precision = ESTIMATED`, e todas as telas exibem "≈ 2 anos"

**AC-04 (Edge Case — peso incompatível com porte)**
- **Dado** um pet com porte `PEQUENO` e peso informado de 45 kg
- **Quando** o cadastro é salvo
- **Então** o sistema aceita (**201**) mas retorna `warnings: [{ code: "WEIGHT_SIZE_MISMATCH", message: "Peso incompatível com o porte selecionado" }]` — aviso, nunca bloqueio, porque o balcão precisa registrar exceções reais

### [MOD-PET-02] — Vínculo N:N Pet↔Tutor

**AC-01 (Happy Path)**
- **Dado** um pet de um casal
- **Quando** o admin adiciona o segundo tutor via `POST /v1/pets/:id/tutors` com `{ tutorId, role: "SECONDARY", relationship: "Cônjuge" }`
- **Então** o vínculo é criado, ambos passam a ver o pet no Portal e ambos podem agendar; retorna **201**

**AC-02 (Validação / Erro)**
- **Dado** um pet que já possui responsável principal
- **Quando** tenta-se adicionar um segundo vínculo com `role = "PRIMARY"`
- **Então** retorna **409** `ERR_PET_004` "Este pet já possui um responsável principal. Altere o atual antes de definir outro."

**AC-03 (Edge Case — remoção do último tutor)**
- **Dado** um pet com um único tutor vinculado
- **Quando** tenta-se remover esse vínculo
- **Então** retorna **409** `ERR_PET_005` "O pet precisa de ao menos um responsável. Use a transferência de titularidade."

**AC-04 (Edge Case — cobrança com dois tutores)**
- **Dado** um pet com dois tutores e um serviço concluído
- **Quando** o débito é lançado
- **Então** o lançamento vai para a conta corrente do **responsável principal**, salvo escolha explícita do atendente no fechamento (MOD-LEDGER)

### [MOD-PET-03] — Tabelas de Domínio

**AC-01 (Happy Path)**
- **Dado** o catálogo global semeado (cão, gato, ave, roedor, réptil, outros + ~250 raças)
- **Quando** o frontend chama `GET /v1/species/:id/breeds`
- **Então** retorna as raças globais da espécie **mais** as raças criadas por este tenant, ordenadas alfabeticamente, servidas de cache com TTL de 24h

**AC-02 (Validação / Erro)**
- **Dado** um `TENANT_ADMIN`
- **Quando** tenta editar ou excluir uma raça global (`tenant_id IS NULL`)
- **Então** retorna **403** `ERR_PET_003` "Raças do catálogo global não podem ser alteradas" — o tenant pode apenas ocultá-la da sua lista (`breed_visibility`)

**AC-03 (Edge Case — raça customizada duplicada)**
- **Dado** que o tenant cria a raça "Golden Retriever" que já existe no catálogo global
- **Quando** submete
- **Então** retorna **409** `ERR_PET_004` com sugestão da raça global equivalente (comparação normalizada: minúsculas, sem acento)

**AC-04 (Edge Case — exclusão de domínio em uso)**
- **Dado** uma raça customizada usada por 14 pets
- **Quando** o admin tenta excluí-la
- **Então** retorna **409** `ERR_PET_006` "14 pets usam esta raça"; o admin pode desativá-la (some do seletor, permanece nos pets existentes)

### [MOD-PET-04] — Álbum de Fotos

**AC-01 (Happy Path)**
- **Dado** um atendente na tela do pet
- **Quando** envia 3 fotos via `POST /v1/pets/:id/photos` (multipart, até 10 MB cada)
- **Então** cada arquivo é validado por magic bytes, enviado ao Cloudflare Images sob o path `tenants/{tenantId}/pets/{petId}/`, o EXIF (inclusive GPS) é removido, os registros são criados com variantes (thumbnail/medium/full) e retorna **201** com as URLs assinadas

**AC-02 (Validação / Erro)**
- **Dado** um arquivo `.pdf` renomeado para `.jpg`, ou um arquivo acima de 10 MB
- **Quando** o upload é tentado
- **Então** retorna **422** `ERR_PET_007` "Formato inválido. Envie JPG, PNG, WEBP ou HEIC de até 10 MB" — a validação é por conteúdo, não por extensão

**AC-03 (Edge Case — cota do plano)**
- **Dado** um tenant STARTER com limite de 500 fotos
- **Quando** o upload que ultrapassa o limite é tentado
- **Então** retorna **402** `ERR_PET_008` "Limite de fotos do plano atingido" com CTA de upgrade

**AC-04 (Edge Case — falha no Cloudflare)**
- **Dado** que o Cloudflare Images retorna 5xx
- **Quando** o upload é tentado
- **Então** retorna **502** `ERR_PET_009` com mensagem amigável, nenhum registro órfão é criado no banco (upload primeiro, persistência depois) e a falha é logada com `trace_id`

**AC-05 (Edge Case — consentimento de imagem)**
- **Dado** um tutor sem consentimento de uso de imagem (`IMAGE_USE = false`)
- **Quando** a foto é marcada para uso em campanha ou no site do tenant
- **Então** retorna **403** `ERR_PET_010` "O tutor não autorizou o uso da imagem do pet" — o upload para uso interno continua permitido

### [MOD-PET-05] — Transferência de Titularidade

**AC-01 (Happy Path)**
- **Dado** um pet adotado por outro tutor
- **Quando** o admin executa `POST /v1/pets/:id/transfer` com `{ toTutorId, reason: "ADOPTION", keepHistory: true, effectiveDate }`
- **Então** os vínculos antigos são encerrados (`unlinked_at`), o novo tutor vira PRIMARY, o histórico clínico permanece integralmente no pet, grava-se `pet_transfer_log`, publica-se `pet.transferido` e retorna **200**

**AC-02 (Validação / Erro)**
- **Dado** um pet com agendamento futuro do tutor anterior
- **Quando** a transferência é solicitada
- **Então** retorna **409** `ERR_PET_005` listando os agendamentos e exigindo cancelamento ou reatribuição

**AC-03 (Edge Case — privacidade pós-transferência)**
- **Dado** um pet transferido
- **Quando** o tutor **anterior** acessa o Portal
- **Então** ele não vê mais o pet nem o histórico posterior à transferência; mantém apenas seus recibos e o histórico de serviços que **ele** pagou (registro financeiro é dele, prontuário é do pet)

### [MOD-PET-08] — Status e Óbito

**AC-01 (Happy Path)**
- **Dado** o comunicado de falecimento do pet
- **Quando** o admin executa `PATCH /v1/pets/:id` com `{ status: "DECEASED", deceasedAt: "2026-08-10" }`
- **Então** o pet sai de todas as listagens operacionais, agendamentos futuros são cancelados automaticamente sem cobrança, **todas as campanhas para os tutores relativas a este pet são suprimidas imediatamente**, publica-se `pet.obito` e retorna **200**

**AC-02 (Edge Case — supressão de campanha sensível)**
- **Dado** um pet falecido cujo aniversário ocorre em 5 dias
- **Quando** o job de aniversários executa
- **Então** o pet é excluído do público-alvo por filtro obrigatório `status = ACTIVE` — enviar "parabéns pelo aniversário do Thor" a um tutor enlutado é falha grave de produto

**AC-03 (Edge Case — reversão de óbito)**
- **Dado** um óbito registrado por engano
- **Quando** um `TENANT_ADMIN` reverte para `ACTIVE` em até 30 dias
- **Então** a reversão é permitida com justificativa obrigatória e auditoria; após 30 dias, exige acionar o suporte

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| pets | id | UUID | ✓ | PK |
| pets | tenant_id | UUID | ✓ | Isolamento multi-tenant (RLS) |
| pets | name | String(60) | ✓ | Nome do pet |
| pets | species_id | UUID | ✓ | FK species |
| pets | breed_id | UUID | — | FK breeds (SRD é uma raça do catálogo) |
| pets | size_id | UUID | ✓ | FK sizes — insumo de preço e duração |
| pets | coat_id | UUID | — | FK coats — insumo de preço e duração |
| pets | sex | Enum | ✓ | MALE, FEMALE, UNKNOWN |
| pets | birth_date | Date | — | Data real |
| pets | birth_date_precision | Enum | ✓ | EXACT, ESTIMATED, UNKNOWN |
| pets | weight_kg | Decimal(5,2) | — | Peso atual (denormalizado do histórico) |
| pets | neutered | Boolean | — | Castrado |
| pets | microchip | String(20) | — | Único por tenant |
| pets | color | String(40) | — | Cor da pelagem |
| pets | cover_photo_id | UUID | — | FK pet_photos |
| pets | status | Enum | ✓ | ACTIVE, INACTIVE, DECEASED, TRANSFERRED_OUT |
| pets | deceased_at | Date | — | Data do óbito |
| pets | notes | Text | — | Observações operacionais |
| pets | search_vector | tsvector | ✓ | Busca full-text |
| pets | created_by / created_at / updated_at / deleted_at | — | ✓ | Auditoria e soft delete |
| pet_tutors | id / tenant_id / pet_id / tutor_id | UUID | ✓ | PK e FKs |
| pet_tutors | role | Enum | ✓ | PRIMARY, SECONDARY |
| pet_tutors | relationship | String(40) | — | Cônjuge, filho, cuidador |
| pet_tutors | can_authorize_procedures | Boolean | ✓ | Autoriza procedimento clínico |
| pet_tutors | linked_at / unlinked_at | Timestamptz | ✓/— | Histórico de vínculo |
| species | id | UUID | ✓ | PK |
| species | tenant_id | UUID | — | **Nulo = catálogo global** |
| species | key / label | String | ✓ | `DOG`, "Cão" |
| species | active | Boolean | ✓ | |
| breeds | id / species_id | UUID | ✓ | PK e FK |
| breeds | tenant_id | UUID | — | Nulo = global |
| breeds | label | String(80) | ✓ | |
| breeds | normalized_label | String(80) | ✓ | Minúsculo sem acento, para dedupe |
| breeds | default_size_id | UUID | — | Sugestão de porte ao selecionar a raça |
| breeds | grooming_notes | Text | — | Nota técnica de tosa da raça |
| sizes | id / tenant_id / key / label | — | ✓ | SMALL, MEDIUM, LARGE, GIANT |
| sizes | weight_min_kg / weight_max_kg | Decimal(5,2) | ✓ | Faixa de referência |
| sizes | sort_order | SmallInt | ✓ | Ordenação na UI |
| coats | id / tenant_id / key / label | — | ✓ | SHORT, LONG, DOUBLE, CURLY, HAIRLESS |
| coats | grooming_time_factor | Decimal(3,2) | ✓ | Multiplicador de duração (ex.: 1.35) |
| pet_photos | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| pet_photos | cloudflare_image_id | String | ✓ | ID no Cloudflare Images |
| pet_photos | variants | JSONB | ✓ | `{ thumb, medium, full }` |
| pet_photos | caption | String(140) | — | Legenda |
| pet_photos | taken_at | Timestamptz | ✓ | Data da foto (default upload) |
| pet_photos | source | Enum | ✓ | STAFF, TUTOR, GROOMING_RESULT |
| pet_photos | attendance_id | UUID | — | Vínculo com atendimento (antes/depois) |
| pet_photos | size_bytes / mime_type | Int / String | ✓ | Controle de cota |
| pet_photos | uploaded_by / created_at / deleted_at | — | ✓ | Auditoria e soft delete |
| pet_weights | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| pet_weights | weight_kg | Decimal(5,2) | ✓ | Pesagem |
| pet_weights | measured_at | Timestamptz | ✓ | Data da medição |
| pet_weights | attendance_id / measured_by | UUID | — | Origem |
| pet_transfer_log | id / tenant_id / pet_id | UUID | ✓ | PK e FKs |
| pet_transfer_log | from_tutor_id / to_tutor_id | UUID | ✓ | Partes |
| pet_transfer_log | reason | Enum | ✓ | ADOPTION, SALE, TUTOR_DEATH, CORRECTION, OTHER |
| pet_transfer_log | performed_by / created_at | — | ✓ | Auditoria |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| microchip | pets | Identificador único rastreável, vinculado indiretamente ao titular |
| notes | pets | Campo livre que pode conter dado pessoal do tutor |

Fotos **não** são cifradas em repouso pela aplicação: ficam no Cloudflare Images com isolamento por path de tenant e acesso via URL assinada com expiração de 15 minutos. Não há URL pública permanente para foto de pet.

### Índices Necessários

```sql
CREATE INDEX idx_pets_tenant ON pets(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_pets_tenant_status ON pets(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_pets_search ON pets USING GIN(search_vector);
CREATE INDEX idx_pets_name_trgm ON pets USING GIN(name gin_trgm_ops);
CREATE UNIQUE INDEX idx_pets_tenant_microchip ON pets(tenant_id, microchip)
  WHERE microchip IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_pets_birthday ON pets(tenant_id, (EXTRACT(MONTH FROM birth_date)), (EXTRACT(DAY FROM birth_date)))
  WHERE status = 'ACTIVE' AND birth_date IS NOT NULL;

CREATE INDEX idx_pet_tutors_pet ON pet_tutors(pet_id) WHERE unlinked_at IS NULL;
CREATE INDEX idx_pet_tutors_tutor ON pet_tutors(tutor_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX idx_pet_primary_tutor ON pet_tutors(pet_id) WHERE role = 'PRIMARY' AND unlinked_at IS NULL;

CREATE UNIQUE INDEX idx_breeds_global_norm ON breeds(species_id, normalized_label) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_breeds_tenant_norm ON breeds(tenant_id, species_id, normalized_label) WHERE tenant_id IS NOT NULL;

CREATE INDEX idx_pet_photos_pet ON pet_photos(pet_id, taken_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_pet_weights_pet ON pet_weights(pet_id, measured_at DESC);
```

> Tabelas de domínio globais (`tenant_id IS NULL`) **não** têm RLS por tenant. A política é: `USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id')::uuid)` para leitura, e `WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)` para escrita — o tenant lê o global mas só escreve o próprio.

## 5. Contratos de API

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/pets | ADMIN, RECEPTIONIST, VET, GROOMER, BATHER | Listar (filtros: `q`, `tutorId`, `speciesId`, `status`, `hasAllergies`) |
| POST | /v1/pets | ADMIN, RECEPTIONIST, VET | Criar pet |
| GET | /v1/pets/:id | ADMIN, RECEPTIONIST, VET, GROOMER, BATHER, TUTOR (próprio) | Detalhe com alertas de prontuário |
| PATCH | /v1/pets/:id | ADMIN, RECEPTIONIST, VET, TUTOR (campos limitados) | Atualizar |
| DELETE | /v1/pets/:id | ADMIN | Soft delete |
| GET | /v1/pets/:id/tutors | ADMIN, RECEPTIONIST, VET | Responsáveis vinculados |
| POST | /v1/pets/:id/tutors | ADMIN, RECEPTIONIST | Vincular tutor |
| PATCH | /v1/pets/:id/tutors/:linkId | ADMIN, RECEPTIONIST | Alterar papel do vínculo |
| DELETE | /v1/pets/:id/tutors/:linkId | ADMIN | Desvincular |
| POST | /v1/pets/:id/transfer | ADMIN | Transferir titularidade |
| GET | /v1/pets/:id/photos | ADMIN, RECEPTIONIST, VET, GROOMER, BATHER, TUTOR (próprio) | Álbum |
| POST | /v1/pets/:id/photos | ADMIN, RECEPTIONIST, VET, GROOMER, BATHER, TUTOR (próprio) | Upload (multipart) |
| PATCH | /v1/pets/:id/photos/:photoId | ADMIN, RECEPTIONIST | Legenda / definir capa |
| DELETE | /v1/pets/:id/photos/:photoId | ADMIN, RECEPTIONIST | Remover foto |
| GET | /v1/pets/:id/weights | ADMIN, RECEPTIONIST, VET | Histórico de peso |
| POST | /v1/pets/:id/weights | ADMIN, RECEPTIONIST, VET, BATHER | Registrar pesagem |
| GET | /v1/species | Todos | Espécies (global + tenant) |
| GET | /v1/species/:id/breeds | Todos | Raças da espécie |
| POST | /v1/breeds | ADMIN | Criar raça do tenant |
| GET | /v1/sizes / /v1/coats | Todos | Portes e pelagens |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const PetSexSchema = z.enum(['MALE','FEMALE','UNKNOWN'])
export const PetStatusSchema = z.enum(['ACTIVE','INACTIVE','DECEASED','TRANSFERRED_OUT'])

export const CreatePetSchema = z.object({
  name: z.string().min(1).max(60),
  speciesId: z.string().uuid(),
  breedId: z.string().uuid().optional(),
  sizeId: z.string().uuid(),
  coatId: z.string().uuid().optional(),
  sex: PetSexSchema.default('UNKNOWN'),
  birthDate: z.string().date().optional(),
  estimatedAgeMonths: z.number().int().min(0).max(360).optional(),
  weightKg: z.number().min(0.05).max(120).optional(),
  neutered: z.boolean().optional(),
  microchip: z.string().regex(/^\d{15}$/, 'Microchip deve ter 15 dígitos').optional(),
  color: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  tutors: z.array(z.object({
    tutorId: z.string().uuid(),
    role: z.enum(['PRIMARY','SECONDARY']),
    relationship: z.string().max(40).optional(),
    canAuthorizeProcedures: z.boolean().default(true),
  })).min(1).refine(
    list => list.filter(t => t.role === 'PRIMARY').length === 1,
    'Informe exatamente um responsável principal',
  ),
}).refine(d => !!d.birthDate || d.estimatedAgeMonths !== undefined, {
  message: 'Informe a data de nascimento ou a idade estimada', path: ['birthDate'],
})
export type CreatePetInput = z.infer<typeof CreatePetSchema>

export const TransferPetSchema = z.object({
  toTutorId: z.string().uuid(),
  reason: z.enum(['ADOPTION','SALE','TUTOR_DEATH','CORRECTION','OTHER']),
  notes: z.string().max(500).optional(),
  effectiveDate: z.string().date().optional(),
  confirmation: z.literal('CONFIRMO_A_TRANSFERENCIA'),
})

export const PetResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  species: z.object({ id: z.string().uuid(), label: z.string() }),
  breed: z.object({ id: z.string().uuid(), label: z.string() }).nullable(),
  size: z.object({ id: z.string().uuid(), label: z.string() }),
  coat: z.object({ id: z.string().uuid(), label: z.string() }).nullable(),
  sex: PetSexSchema,
  ageMonths: z.number().int().nullable(),
  ageLabel: z.string().nullable(),              // "≈ 2 anos"
  weightKg: z.number().nullable(),
  status: PetStatusSchema,
  coverPhotoUrl: z.string().url().nullable(),   // URL assinada, 15 min
  alerts: z.array(z.object({                    // agregado de MOD-PRONT
    type: z.enum(['ALLERGY','TEMPERAMENT','MEDICAL']),
    severity: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']),
    label: z.string(),
  })),
  tutors: z.array(z.object({
    tutorId: z.string().uuid(), fullName: z.string(),
    role: z.enum(['PRIMARY','SECONDARY']), phoneMasked: z.string(),
  })),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_PET_001 | 404 | Pet não encontrado neste tenant |
| ERR_PET_002 | 422 | Dados inválidos (raça x espécie, idade ausente, microchip malformado) |
| ERR_PET_003 | 403 | Papel insuficiente ou tentativa de editar catálogo global |
| ERR_PET_004 | 409 | Conflito (microchip duplicado, segundo tutor PRIMARY, raça duplicada) |
| ERR_PET_005 | 409 | Operação bloqueada por vínculo (último tutor, agendamento futuro) |
| ERR_PET_006 | 409 | Item de domínio em uso não pode ser excluído |
| ERR_PET_007 | 422 | Arquivo de imagem inválido ou acima do limite |
| ERR_PET_008 | 402 | Cota de fotos do plano atingida |
| ERR_PET_009 | 502 | Falha no Cloudflare Images |
| ERR_PET_010 | 403 | Uso de imagem sem consentimento do tutor |

## 6. Máquinas de Estado

### Pet — Status

```
ACTIVE ──(sem atendimento há 12 meses OU desativação manual)──► INACTIVE
  │                                                                │
  │◄──────────────────(novo atendimento/reativação)────────────────┘
  │
  ├─(registro de óbito)──────────► DECEASED ──(reversão em até 30 dias, ADMIN + justificativa)──► ACTIVE
  │
  └─(transferência para fora do tenant)──► TRANSFERRED_OUT (terminal no tenant de origem)
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| — | ACTIVE | `pet.criado` | — | ✓ |
| ACTIVE | INACTIVE | `pet.inativado` | Campanha de reativação (MOD-CRM) | ✓ |
| ACTIVE | DECEASED | `pet.obito` | **Supressão imediata de campanhas**; cancelamento sem taxa de agendamentos futuros | ✓ |
| ACTIVE | ACTIVE (transferência) | `pet.transferido` | Notificação ao novo tutor | ✓ |
| Qualquer | — (peso registrado) | `pet.peso.registrado` | Alerta ao veterinário se variação > 15% em 60 dias | ✓ |

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Domínios estruturados | Espécie/raça/porte/pelagem **nunca** são texto livre — requisito explícito do PRD §7.2 para relatórios e IA | MOD-PET, MOD-AI |
| RN-02 | Catálogo global vs. tenant | Global é somente leitura para o tenant, que pode ocultar itens e criar os seus | MOD-PET, MOD-ADMIN |
| RN-03 | Porte e pelagem definem preço/duração | `duração = duração_base_serviço × fator_porte × coats.grooming_time_factor` | MOD-AGENDA |
| RN-04 | Um responsável principal | Exatamente um PRIMARY ativo por pet, garantido por índice único parcial | MOD-PET, MOD-LEDGER |
| RN-05 | Débito vai ao principal | Salvo escolha explícita no fechamento do atendimento | MOD-LEDGER |
| RN-06 | Prontuário segue o pet | Transferência move a titularidade, nunca o histórico clínico | MOD-PRONT |
| RN-07 | Tutor anterior perde acesso | Após a transferência, o Portal do tutor antigo esconde o pet, preservando os recibos dele | MOD-PORTAL |
| RN-08 | Óbito suprime campanhas | Filtro obrigatório `pet.status = ACTIVE` em todo público-alvo de campanha | MOD-CRM |
| RN-09 | Alerta de alergia | `GET /v1/pets/:id` sempre traz `alerts[]` agregado do prontuário; agendamento e check-in exibem `CRITICAL` como bloqueio suave (exige confirmação) | MOD-PRONT, MOD-AGENDA |
| RN-10 | Peso denormalizado | `pets.weight_kg` reflete sempre a pesagem mais recente; a série fica em `pet_weights` | MOD-PRONT |
| RN-11 | Variação de peso relevante | Queda/ganho > 15% em 60 dias gera alerta ao veterinário | MOD-PRONT, MOD-ALERT |
| RN-12 | EXIF removido | Fotos podem conter GPS da casa do tutor — remoção obrigatória no processamento | MOD-SEC |
| RN-13 | URL de foto é assinada | Expiração de 15 min; nenhuma imagem de pet é publicamente enumerável | MOD-SEC, MOD-PORTAL |
| RN-14 | Uso de imagem em marketing | Exige consentimento `IMAGE_USE` do tutor no momento do uso, não apenas no upload | MOD-TUTOR, MOD-SITE, MOD-CRM |
| RN-15 | Microchip único por tenant | Dois pets com o mesmo microchip indicam erro de digitação ou duplicata — 409 com link ao existente | MOD-PET |
| RN-16 | Nome duplicado é normal | Cinco "Mel" no mesmo tenant é esperado; a UI desambigua por foto, raça e tutor | MOD-PET, MOD-AGENDA |

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `pet.criado` | pet-service | medical-record (cria ficha), crm-automation, audit | `{ tenantId, petId, speciesKey, primaryTutorId, birthDate, timestamp }` |
| `pet.atualizado` | pet-service | scheduling (recalcula duração), portal-bff, audit | `{ tenantId, petId, changedFields[], timestamp }` |
| `pet.transferido` | pet-service | medical-record, billing-ledger, scheduling, notification, audit | `{ tenantId, petId, fromTutorId, toTutorId, reason, timestamp }` |
| `pet.obito` | pet-service | scheduling (cancela futuros), crm-automation (suprime), notification, audit | `{ tenantId, petId, tutorIds[], deceasedAt, timestamp }` |
| `pet.inativado` | pet-service | crm-automation, audit | `{ tenantId, petId, lastAttendanceAt, timestamp }` |
| `pet.foto.adicionada` | pet-service | portal-bff, crm-automation (foto pós-tosa ao tutor), audit | `{ tenantId, petId, photoId, source, attendanceId, timestamp }` |
| `pet.peso.registrado` | pet-service | medical-record, notification, audit | `{ tenantId, petId, weightKg, previousWeightKg, variationPercent, timestamp }` |
| `pet.vinculo.alterado` | pet-service | billing-ledger, portal-bff, audit | `{ tenantId, petId, tutorId, action, role, timestamp }` |

Consome: `tutor.anonimizado` (desvincula e mantém o pet como órfão), `tutor.mesclado` (revincula pets ao tutor destino), `atendimento.concluido` (atualiza `last_attendance_at` e peso, se aferido).

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Listar pets | ✓¹ | ✓ | ✓ | ✓ (do dia) | ✓ | corrida atribuída | próprios |
| Ver detalhe | ✓¹ | ✓ | ✓ | ✓ + alertas | ✓ | nome/porte | próprios |
| Criar | — | ✓ | ✓ | — | ✓ | — | próprios² |
| Editar | — | ✓ | ✓ | peso/observação | ✓ | — | limitado³ |
| Excluir | — | ✓ | — | — | — | — | — |
| Transferir | — | ✓ | — | — | — | — | — |
| Registrar óbito | — | ✓ | ✓ | — | ✓ | — | — |
| Upload de foto | — | ✓ | ✓ | ✓ | ✓ | — | ✓ (próprios) |
| Excluir foto | — | ✓ | ✓ | própria | própria | — | própria |
| Editar catálogo do tenant | — | ✓ | — | — | — | — | — |
| Editar catálogo global | ✓ | — | — | — | — | — | — |

¹ Somente com grant de suporte ativo e auditoria por leitura.
² Cadastro pelo Portal entra com `data_completeness = PARTIAL` e passa por revisão da recepção.
³ Tutor edita nome, foto, peso e observações; nunca espécie, raça ou microchip sem validação da equipe.

### Audit Log — ações que DEVEM gerar registro imutável

- `pet.created`, `pet.updated` (diff), `pet.deleted` → `action`, `entity`, `entityId`, `userId`, `tenantId`, `before`, `after`, `ipAddress`
- `pet.transferred` (com motivo e partes), `pet.deceased`, `pet.deceased_reverted` (justificativa obrigatória)
- `pet.tutor_linked`, `pet.tutor_unlinked`, `pet.primary_tutor_changed`
- `pet.photo_uploaded`, `pet.photo_deleted`
- `breed.created`, `breed.deactivated`

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| Dados do pet (nome, raça, peso) | Dado pessoal por associação ao tutor | Execução de contrato | Relação ativa + 5 anos | ✓ | ✓ (anonimização do vínculo) |
| microchip | Identificador único | Execução de contrato | Relação ativa + 5 anos | ✓ | ✓ |
| Fotos do pet | Dado pessoal (pode conter pessoas e local) | Consentimento (marketing) / contrato (registro do serviço) | Relação ativa + 2 anos | ✓ | ✓ (exclusão real no Cloudflare) |
| EXIF/GPS | Dado de localização | — | **Removido no upload** | — | — |
| notes | Risco de dado sensível | Legítimo interesse | Relação ativa | ✓ | ✓ |

> Direito ao esquecimento: a exclusão de fotos deve chamar a API de delete do Cloudflare Images, não apenas marcar `deleted_at` — job `media-purge` diário reconcilia registros soft-deleted há mais de 30 dias com o storage.

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Catálogo de espécies/raças/portes/pelagens | 86400s | `catalog:{tenantId}:{type}` | Criação/desativação de item do tenant |
| Detalhe do pet + alertas | 120s | `pet:{tenantId}:{petId}` | `pet.atualizado`, `prontuario.alerta.alterado` |
| Pets do tutor (Portal) | 300s | `pet:bytutor:{tenantId}:{tutorId}` | `pet.vinculo.alterado`, `pet.criado` |
| URL assinada de foto | 840s (< 15 min) | `photo:url:{photoId}` | Expiração natural |

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "pet_photo_upload_duration", "tenantId": "...", "value": 1240, "unit": "ms" }
```

- `pet_created_total`: cadastros por espécie e origem — contínuo
- `pet_per_tutor_avg`: média de pets por tutor — semanal (indicador de ticket potencial)
- `pet_photo_upload_duration` e `pet_photo_upload_failed_total`: saúde da integração Cloudflare — contínuo
- `pet_storage_bytes_per_tenant`: consumo de mídia vs. cota do plano — diário
- `pet_custom_breed_created_total`: raças criadas pelos tenants — mensal (insumo para expandir o catálogo global)
- `pet_alerts_active_total`: pets com alerta CRITICAL ativo — diário (segurança da equipe)
- `pet_weight_variation_alert_total`: alertas clínicos gerados — semanal

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/pets?q=` | 300ms | Busca de balcão |
| `GET /v1/pets/:id` | 200ms | Inclui agregação de alertas do prontuário |
| `POST /v1/pets/:id/photos` | 3s | Upload de até 10 MB com processamento |
| `GET /v1/species/:id/breeds` | 60ms | Servido de cache |

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Cotas de mídia por plano (assumido 500 / 5.000 / ilimitado fotos) e política ao exceder | MOD-PET, MOD-ADMIN, custo | PM comercial | Antes da Fase 1 |
| 2 | Cloudflare Images vs. R2 + Workers para variantes — custo por 1.000 imagens no volume projetado | MOD-PET, infra | Tech Lead | Fase 1 |
| 3 | Origem e licença do catálogo global de raças (~250 itens) | MOD-PET, jurídico | PM | Antes da Fase 1 |
| 4 | Carteira de vacinação como módulo próprio com calendário, ou apenas atendimento no prontuário? | MOD-PRONT, MOD-CRM | PM + veterinário consultor | Fase 2 |
| 5 | Retenção de fotos após encerramento da relação (assumido 2 anos) | MOD-SEC, custo | DPO | Fase 7 |
| 6 | Pet pode existir sem tutor (resgate/abrigo)? Hoje exige ao menos um responsável | MOD-PET, MOD-LEDGER | PM | Pós-MVP |
