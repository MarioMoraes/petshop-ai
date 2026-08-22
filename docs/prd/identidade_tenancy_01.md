# PRD Detalhado — Identidade, Tenancy e Controle de Acesso

**Módulo:** MOD-IDENT
**Arquivo:** 01/15
**Prioridade:** P0
**Fase de Implementação:** 0 — Fundação
**Serviço Backend:** identity-service (porta 3001) | api-gateway (porta 3000)
**Tabelas Principais:** tenants, tenant_settings, users, memberships, roles, permissions, role_permissions, invitations, audit_logs
**Data:** 2026-08-21
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** Todo o PetShop AI é vendido por tenant: um petshop = uma instância isolada de dados, usuários, configurações e identidade visual. Este módulo é a fundação comercial e técnica do produto — sem ele não existe cobrança por assinatura, não existe isolamento LGPD entre petshops concorrentes e não existe o controle de quem pode ver o prontuário de um pet ou o extrato financeiro de um tutor. O petshop-alvo (1 a 5 unidades, equipe de 3 a 15 pessoas) precisa de um onboarding self-service que leve menos de 10 minutos do cadastro ao primeiro tutor cadastrado, porque é um público pouco digitalizado e com baixa tolerância a fricção de configuração.

**Integração sistêmica.** Este é o módulo upstream de **todos** os demais. Cada serviço do SPEC §2 recebe o `tenant_id` e o conjunto de permissões resolvidos aqui e propagados pelo API Gateway no JWT. Downstream diretos: MOD-TUTOR, MOD-PET, MOD-PRONT, MOD-LEDGER, MOD-AGENDA (que resolve `professional` a partir de `user`), MOD-SEC (MFA e consentimento), MOD-ADMIN (billing e uso por tenant), MOD-AI (least privilege dos agentes). Upstream externo: **Clerk** (Organizations = tenants, Organization Memberships = vínculo usuário↔tenant) e **Cloudflare** (resolução de subdomínio do tenant, detalhada em MOD-SITE).

**Escopo desta fase.** Inclui: provisionamento de tenant via onboarding self-service (5 etapas), sincronização bidirecional com Clerk via webhooks, RBAC com 8 papéis padrão e permissões granulares por módulo, convite de membros por e-mail, RLS PostgreSQL habilitado em todas as tabelas de negócio, e trilha de auditoria append-only. Fica para fases posteriores: RBAC totalmente customizável pelo tenant (criação de papéis próprios — v1 entrega papéis fixos com permissões ajustáveis), SSO/SAML corporativo, multi-unidade dentro de um mesmo tenant (v1 = 1 tenant por unidade), e migração de tenant Enterprise para schema/banco dedicado.

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-IDENT-01 | Provisionamento de Tenant | Criação do tenant, slug único, plano inicial e configurações padrão | Must Have |
| MOD-IDENT-02 | Onboarding Wizard (5 etapas) | Fluxo guiado: dados do petshop → plano → configuração operacional → convite de equipe → primeiro acesso | Must Have |
| MOD-IDENT-03 | Sincronização Clerk | Webhooks `user.*` e `organization.*` mantendo espelho local de usuários e organizações | Must Have |
| MOD-IDENT-04 | RBAC — Papéis e Permissões | 8 papéis padrão, matriz de permissões por módulo, verificação em gateway e serviço | Must Have |
| MOD-IDENT-05 | Membership Multi-tenant | Um usuário pertencendo a N tenants com papel distinto em cada, com troca de contexto | Must Have |
| MOD-IDENT-06 | Convites de Equipe | Convite por e-mail com papel pré-atribuído, expiração em 7 dias, reenvio e revogação | Must Have |
| MOD-IDENT-07 | Isolamento RLS | Políticas `tenant_id` no PostgreSQL + middleware que injeta `app.tenant_id` por transação | Must Have |
| MOD-IDENT-08 | Configurações do Tenant | Identidade visual, fuso, horário de funcionamento, políticas operacionais (ex.: janela de cancelamento) | Must Have |
| MOD-IDENT-09 | Trilha de Auditoria | Registro append-only de ações sensíveis de identidade e acesso | Must Have |
| MOD-IDENT-10 | Suspensão e Encerramento | Suspensão por inadimplência, reativação e encerramento com retenção legal | Should Have |
| MOD-IDENT-11 | Impersonation de Suporte | Super Admin assumindo sessão do tenant com consentimento e auditoria reforçada | Nice to Have |

## 3. Critérios de Aceite

### [MOD-IDENT-01] — Provisionamento de Tenant

**AC-01 (Happy Path)**
- **Dado** que um visitante concluiu o cadastro no Clerk e não possui nenhum tenant
- **Quando** envia `POST /v1/tenants` com `{ name: "Petshop do João", slug: "petshopdojoao", plan: "starter", timezone: "America/Sao_Paulo" }`
- **Então** o sistema cria o tenant com `status = PROVISIONING`, cria a Organization correspondente no Clerk, cria o `membership` do solicitante com papel `TENANT_ADMIN`, semeia as tabelas de domínio padrão (espécies, portes, pelagens, serviços-modelo), transiciona para `status = TRIAL` com `trial_ends_at = now() + 14 dias`, publica `tenant.criado` e retorna **201** com `{ id, slug, status: "TRIAL", onboardingStep: 1 }`

**AC-02 (Validação / Erro)**
- **Dado** que já existe um tenant com `slug = "petshopdojoao"`
- **Quando** outro usuário tenta `POST /v1/tenants` com o mesmo slug
- **Então** o sistema retorna **409** `ERR_IDENT_004` com mensagem "Este endereço já está em uso. Sugestões: petshopdojoao-sp, petshopdojoao2" e **não** cria nada no Clerk

**AC-03 (Edge Case — falha parcial no provisionamento)**
- **Dado** que o tenant foi criado localmente mas a chamada de criação da Organization no Clerk falhou com timeout
- **Quando** o job `tenant-provisioning-retry` executa (a cada 2 min, máx. 5 tentativas)
- **Então** o tenant permanece em `PROVISIONING`, a operação é reexecutada de forma idempotente usando `provisioning_key`, e após a 5ª falha o tenant vai para `PROVISIONING_FAILED`, um alerta é enviado ao Super Admin e o usuário vê a tela "Estamos finalizando sua conta" em vez de erro cru

**AC-04 (Edge Case — slug reservado)**
- **Dado** que o slug solicitado é `admin`, `api`, `www`, `app`, `portal` ou consta na blocklist
- **Quando** o usuário submete o formulário
- **Então** o sistema retorna **422** `ERR_IDENT_002` com mensagem "Este endereço é reservado pela plataforma"

### [MOD-IDENT-02] — Onboarding Wizard

**AC-01 (Happy Path)**
- **Dado** um tenant em `status = TRIAL` com `onboarding_step = 1`
- **Quando** o admin conclui as 5 etapas (dados do petshop → escolha de plano → configuração operacional: horário, serviços e profissionais → convite de equipe → primeiro acesso)
- **Então** cada etapa persiste parcialmente via `PATCH /v1/tenants/me/onboarding`, o campo `onboarding_step` avança, ao final `onboarding_completed_at` é preenchido, publica-se `tenant.onboarding.concluido` e o usuário é redirecionado ao dashboard com o checklist "Cadastre seu primeiro tutor"

**AC-02 (Validação / Erro)**
- **Dado** que o admin está na etapa 3 e informa horário de funcionamento com `opensAt = 18:00` e `closesAt = 09:00` no mesmo dia
- **Quando** submete a etapa
- **Então** o sistema retorna **422** `ERR_IDENT_002` com mensagem "Horário de fechamento deve ser posterior ao de abertura"

**AC-03 (Edge Case — abandono)**
- **Dado** que o admin abandonou o wizard na etapa 2 há 3 dias
- **Quando** faz login novamente
- **Então** é redirecionado automaticamente para a etapa 2 com os dados já preenchidos, e as etapas 4 e 5 podem ser puladas (`skipped = true`) sem bloquear o uso do sistema — apenas o checklist do dashboard permanece pendente

### [MOD-IDENT-03] — Sincronização Clerk

**AC-01 (Happy Path)**
- **Dado** que um usuário atualiza nome e e-mail no Clerk
- **Quando** o webhook `user.updated` chega em `POST /v1/webhooks/clerk` com assinatura Svix válida
- **Então** o sistema valida a assinatura, faz **upsert** em `users` pela chave `clerk_user_id`, registra em `audit_logs` e retorna **200** em menos de 3s

**AC-02 (Validação / Erro)**
- **Dado** um payload com assinatura Svix inválida ou timestamp fora da janela de 5 minutos
- **Quando** o webhook é recebido
- **Então** o sistema retorna **401** `ERR_IDENT_005`, **não** processa o payload e registra tentativa em `security_events` (MOD-SEC)

**AC-03 (Edge Case — evento duplicado / fora de ordem)**
- **Dado** que o mesmo `svix_id` já foi processado, ou que chega um `user.updated` com `updated_at` anterior ao último aplicado
- **Quando** o webhook é reprocessado
- **Então** o sistema ignora o evento (idempotência por `webhook_events.external_event_id` + comparação de versão) e retorna **200** sem alterar dados

### [MOD-IDENT-04] — RBAC

**AC-01 (Happy Path)**
- **Dado** um usuário com papel `RECEPTIONIST` no tenant A
- **Quando** chama `GET /v1/tutors`
- **Então** recebe **200** com a lista de tutores do tenant A, pois `tutor:read` está na matriz do papel

**AC-02 (Validação / Erro)**
- **Dado** o mesmo usuário `RECEPTIONIST`
- **Quando** chama `DELETE /v1/tutors/:id`
- **Então** recebe **403** `ERR_IDENT_003` com mensagem "Seu perfil não permite excluir tutores" e a tentativa é registrada em `audit_logs` com `outcome = DENIED`

**AC-03 (Edge Case — papel alterado com sessão ativa)**
- **Dado** que o admin rebaixou um usuário de `TENANT_ADMIN` para `RECEPTIONIST` enquanto ele tem JWT válido por mais 8 minutos
- **Quando** o usuário tenta uma operação administrativa
- **Então** o gateway consulta a versão de permissões em cache Redis (`perm:{tenantId}:{userId}`, invalidada na alteração), detecta divergência com o `permVersion` do token, força refresh e aplica o papel novo — **403** se não autorizado

### [MOD-IDENT-05] — Membership Multi-tenant

**AC-01 (Happy Path)**
- **Dado** um usuário com membership ativo em 2 tenants (ex.: franqueado com duas unidades)
- **Quando** chama `POST /v1/sessions/switch-tenant` com `{ tenantId }`
- **Então** recebe **200** com novo par de tokens contendo `tenant_id` e permissões do tenant destino, e a troca é auditada

**AC-02 (Validação / Erro)**
- **Dado** um usuário sem membership no tenant B
- **Quando** tenta `switch-tenant` para o tenant B
- **Então** recebe **403** `ERR_IDENT_003` "Você não tem acesso a este estabelecimento" — sem revelar se o tenant existe

**AC-03 (Edge Case — último admin)**
- **Dado** um tenant com exatamente um usuário de papel `TENANT_ADMIN`
- **Quando** alguém tenta remover esse membership ou rebaixar seu papel
- **Então** o sistema retorna **409** `ERR_IDENT_004` "O estabelecimento precisa de ao menos um administrador"

### [MOD-IDENT-06] — Convites de Equipe

**AC-01 (Happy Path)**
- **Dado** um `TENANT_ADMIN` autenticado
- **Quando** envia `POST /v1/invitations` com `{ email, role: "GROOMER" }`
- **Então** o convite é criado com `status = PENDING` e `expires_at = now() + 7 dias`, um e-mail é enfileirado via MOD-NOTIF e o retorno é **201**

**AC-02 (Validação / Erro)**
- **Dado** que o e-mail já possui membership ativo no tenant
- **Quando** o convite é enviado
- **Então** retorna **409** `ERR_IDENT_004` "Esta pessoa já faz parte da sua equipe"

**AC-03 (Edge Case — convite expirado / limite de plano)**
- **Dado** um convite com `expires_at` no passado, ou um tenant que já atingiu o limite de usuários do plano
- **Quando** o convidado clica no link, ou o admin tenta convidar além do limite
- **Então** no primeiro caso retorna **410** `ERR_IDENT_006` "Convite expirado — peça um novo ao administrador"; no segundo, **402** `ERR_IDENT_007` "Limite de usuários do plano Starter atingido (5). Faça upgrade para adicionar mais."

### [MOD-IDENT-07] — Isolamento RLS

**AC-01 (Happy Path)**
- **Dado** uma requisição autenticada do tenant A
- **Quando** qualquer serviço abre transação
- **Então** o middleware Prisma executa `SET LOCAL app.tenant_id = '<uuid>'` antes de qualquer query, e as políticas RLS filtram automaticamente

**AC-02 (Validação / Erro — cross-tenant)**
- **Dado** um usuário do tenant A com o UUID de um tutor do tenant B
- **Quando** chama `GET /v1/tutors/{id_do_tenant_B}`
- **Então** recebe **404** `ERR_IDENT_001` (nunca 403 — não revelar existência), e o evento é registrado como `CROSS_TENANT_ATTEMPT` em `security_events`

**AC-03 (Edge Case — contexto ausente)**
- **Dado** um job ou consumidor de fila que não setou `app.tenant_id`
- **Quando** executa uma query em tabela com RLS
- **Então** o retorno é vazio (política nega por padrão) e o serviço emite log `level: error, code: TENANT_CONTEXT_MISSING` — jobs cross-tenant devem usar explicitamente a role `app_maintenance` com `BYPASSRLS`, jamais a role de aplicação

### [MOD-IDENT-08] — Configurações do Tenant

**AC-01 (Happy Path)**
- **Dado** um `TENANT_ADMIN`
- **Quando** faz `PATCH /v1/tenants/me/settings` com `{ cancellationWindowHours: 24, noShowFeePercent: 50, branding: { primaryColor: "#0F766E" } }`
- **Então** as configurações são persistidas, o cache Redis `tenant:settings:{tenantId}` é invalidado, publica-se `tenant.configuracao.atualizada` e retorna **200**

**AC-02 (Validação / Erro)**
- **Dado** um valor `cancellationWindowHours = 200`
- **Quando** submetido
- **Então** retorna **422** `ERR_IDENT_002` "Janela de cancelamento deve estar entre 0 e 72 horas"

**AC-03 (Edge Case — alteração retroativa)**
- **Dado** que existem agendamentos futuros já criados sob a janela de 24h e o admin altera para 48h
- **Quando** a alteração é salva
- **Então** agendamentos **já existentes** mantêm a política vigente no momento da criação (snapshot em `appointments.cancellation_policy_snapshot`); a nova regra vale apenas para agendamentos criados a partir de então

### [MOD-IDENT-10] — Suspensão e Encerramento

**AC-01 (Happy Path)**
- **Dado** um tenant com fatura em aberto há 15 dias
- **Quando** o job de inadimplência (MOD-ADMIN) dispara `tenant.suspenso`
- **Então** o tenant vai para `SUSPENDED`, logins de operação retornam **402** com tela de regularização, mas o site público e a exportação de dados permanecem acessíveis

**AC-02 (Edge Case — encerramento com retenção legal)**
- **Dado** um tenant que solicita encerramento e possui lançamentos financeiros dos últimos 5 anos
- **Quando** o encerramento é confirmado
- **Então** o tenant vai para `TERMINATED`, todos os acessos são revogados, dados pessoais de tutores são anonimizados em D+30 e os lançamentos financeiros são retidos por 5 anos em base fria (obrigação fiscal), conforme MOD-SEC

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| tenants | id | UUID | ✓ | PK |
| tenants | slug | String(50) | ✓ | Único global; usado no subdomínio |
| tenants | name | String(120) | ✓ | Nome fantasia do petshop |
| tenants | legal_name | String(160) | — | Razão social |
| tenants | cnpj | String (cifrado) | — | CNPJ do estabelecimento |
| tenants | clerk_org_id | String | ✓ | Organization correspondente no Clerk |
| tenants | status | Enum | ✓ | PROVISIONING, TRIAL, ACTIVE, PAST_DUE, SUSPENDED, TERMINATED, PROVISIONING_FAILED |
| tenants | plan | Enum | ✓ | STARTER, PRO, ENTERPRISE |
| tenants | trial_ends_at | Timestamptz | — | Fim do trial de 14 dias |
| tenants | onboarding_step | SmallInt | ✓ | 1..5 |
| tenants | onboarding_completed_at | Timestamptz | — | Conclusão do wizard |
| tenants | provisioning_key | String | ✓ | Chave de idempotência do provisionamento |
| tenants | created_at / updated_at / deleted_at | Timestamptz | ✓/✓/— | Soft delete |
| tenant_settings | tenant_id | UUID | ✓ | PK e FK (1:1) |
| tenant_settings | timezone | String | ✓ | Default `America/Sao_Paulo` |
| tenant_settings | cancellation_window_hours | SmallInt | ✓ | **Default 24** (decisão de negócio) |
| tenant_settings | no_show_fee_percent | SmallInt | ✓ | % do serviço debitado em no-show; default 0 |
| tenant_settings | allow_overbooking | Boolean | ✓ | Default false |
| tenant_settings | online_booking_enabled | Boolean | ✓ | Habilita agendamento pelo Portal |
| tenant_settings | min_booking_notice_hours | SmallInt | ✓ | Antecedência mínima; default 2 |
| tenant_settings | branding | JSONB | ✓ | `{ logoUrl, primaryColor, secondaryColor }` |
| tenant_settings | business_hours | JSONB | ✓ | Grade semanal padrão |
| tenant_settings | whatsapp_provisioning | Enum | ✓ | OWN_NUMBER (padrão) — número próprio via BSP |
| users | id | UUID | ✓ | PK |
| users | clerk_user_id | String | ✓ | Único global |
| users | email | String (cifrado) | ✓ | PII |
| users | full_name | String(120) | ✓ | |
| users | phone | String (cifrado) | — | PII |
| users | avatar_url | String | — | |
| users | mfa_enabled | Boolean | ✓ | Espelho do Clerk |
| users | status | Enum | ✓ | ACTIVE, DISABLED |
| memberships | id | UUID | ✓ | PK |
| memberships | tenant_id | UUID | ✓ | Isolamento multi-tenant |
| memberships | user_id | UUID | ✓ | FK users |
| memberships | role_key | String | ✓ | FK roles |
| memberships | status | Enum | ✓ | ACTIVE, SUSPENDED, REMOVED |
| memberships | is_professional | Boolean | ✓ | Indica espelho em `professionals` (MOD-AGENDA) |
| memberships | invited_by | UUID | — | FK users |
| memberships | joined_at | Timestamptz | ✓ | |
| roles | key | String | ✓ | PK: SUPER_ADMIN, TENANT_ADMIN, RECEPTIONIST, GROOMER, BATHER, VET, DRIVER, TUTOR |
| roles | label | String | ✓ | Rótulo em pt-BR |
| roles | is_system | Boolean | ✓ | Papéis de sistema não podem ser excluídos |
| permissions | key | String | ✓ | PK no formato `recurso:acao` (ex.: `tutor:delete`) |
| role_permissions | role_key / permission_key | String | ✓ | PK composta; sobrescrita por tenant em `tenant_role_overrides` |
| invitations | id | UUID | ✓ | PK |
| invitations | tenant_id | UUID | ✓ | |
| invitations | email | String (cifrado) | ✓ | |
| invitations | role_key | String | ✓ | |
| invitations | token_hash | String | ✓ | SHA-256 do token; token cru nunca persistido |
| invitations | status | Enum | ✓ | PENDING, ACCEPTED, EXPIRED, REVOKED |
| invitations | expires_at | Timestamptz | ✓ | +7 dias |
| audit_logs | id | UUID | ✓ | PK |
| audit_logs | tenant_id | UUID | — | Nulo para ações de plataforma |
| audit_logs | actor_user_id | UUID | — | Nulo para ações de sistema |
| audit_logs | action | String | ✓ | Ex.: `membership.role_changed` |
| audit_logs | entity / entity_id | String / UUID | ✓ | Alvo da ação |
| audit_logs | before / after | JSONB | — | Diff sanitizado (PII mascarada) |
| audit_logs | outcome | Enum | ✓ | ALLOWED, DENIED |
| audit_logs | ip_address / user_agent | Inet / String | — | Origem |
| audit_logs | created_at | Timestamptz | ✓ | Append-only |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| email | users, invitations | Dado pessoal identificável; reduz impacto de vazamento de dump |
| phone | users | Dado pessoal de contato direto |
| cnpj | tenants | Dado cadastral empresarial sensível a fraude |

Implementação: envelope encryption. Chave mestra (KEK) em secret manager; DEK por tenant em `tenant_keys`, cifrada pela KEK. Formato armazenado: `v1:<iv_base64>:<authTag_base64>:<ciphertext_base64>`. Busca por e-mail usa coluna auxiliar `email_hash` (HMAC-SHA256 com pepper global) com índice único, jamais `LIKE` sobre texto cifrado.

### Índices Necessários

```sql
CREATE UNIQUE INDEX idx_tenants_slug ON tenants(slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_tenants_clerk_org ON tenants(clerk_org_id);
CREATE INDEX idx_tenants_status ON tenants(status) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_users_clerk ON users(clerk_user_id);
CREATE UNIQUE INDEX idx_users_email_hash ON users(email_hash);

CREATE UNIQUE INDEX idx_memberships_tenant_user ON memberships(tenant_id, user_id) WHERE status <> 'REMOVED';
CREATE INDEX idx_memberships_user ON memberships(user_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_memberships_tenant_role ON memberships(tenant_id, role_key);

CREATE UNIQUE INDEX idx_invitations_pending ON invitations(tenant_id, email_hash) WHERE status = 'PENDING';
CREATE INDEX idx_invitations_expires ON invitations(expires_at) WHERE status = 'PENDING';

CREATE INDEX idx_audit_tenant_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id, created_at DESC);
```

### Política RLS (padrão replicado em todos os módulos)

```sql
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

O middleware Prisma (`packages/db/tenant-middleware.ts`) executa, dentro de cada `$transaction`:
`SET LOCAL app.tenant_id = $1` — `SET LOCAL` garante que o valor não vaza entre requisições que reusam a mesma conexão do pool.

## 5. Contratos de API

Todos os endpoints exigem `Authorization: Bearer <jwt>` (exceto webhooks e criação inicial de tenant) e inferem `tenant_id` do JWT. Paginação padrão `?page=1&limit=20`; respostas paginadas retornam `{ data, total, page, limit }`.

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| POST | /v1/tenants | Usuário autenticado sem tenant | Provisionar novo tenant |
| GET | /v1/tenants/me | Todos do tenant | Dados do tenant corrente |
| PATCH | /v1/tenants/me | TENANT_ADMIN | Atualizar dados cadastrais |
| PATCH | /v1/tenants/me/onboarding | TENANT_ADMIN | Avançar etapa do wizard |
| GET | /v1/tenants/me/settings | TENANT_ADMIN, RECEPTIONIST | Ler configurações |
| PATCH | /v1/tenants/me/settings | TENANT_ADMIN | Atualizar configurações |
| GET | /v1/memberships | TENANT_ADMIN, RECEPTIONIST | Listar equipe |
| PATCH | /v1/memberships/:id | TENANT_ADMIN | Alterar papel/status |
| DELETE | /v1/memberships/:id | TENANT_ADMIN | Remover da equipe |
| POST | /v1/invitations | TENANT_ADMIN | Convidar membro |
| POST | /v1/invitations/:id/resend | TENANT_ADMIN | Reenviar convite |
| DELETE | /v1/invitations/:id | TENANT_ADMIN | Revogar convite |
| POST | /v1/invitations/accept | Público autenticado | Aceitar convite via token |
| GET | /v1/me | Autenticado | Perfil + memberships + permissões |
| POST | /v1/sessions/switch-tenant | Autenticado com N memberships | Trocar contexto de tenant |
| GET | /v1/roles | TENANT_ADMIN | Papéis e matriz de permissões |
| POST | /v1/webhooks/clerk | Público (Svix assinado) | Sincronização Clerk |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{2,49}$/

export const CreateTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(SLUG_REGEX, 'Use apenas letras minúsculas, números e hífen'),
  legalName: z.string().max(160).optional(),
  cnpj: z.string().regex(/^\d{14}$/).optional(),
  plan: z.enum(['STARTER', 'PRO', 'ENTERPRISE']).default('STARTER'),
  timezone: z.string().default('America/Sao_Paulo'),
})
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>

export const TenantSettingsSchema = z.object({
  timezone: z.string(),
  cancellationWindowHours: z.number().int().min(0).max(72).default(24),
  noShowFeePercent: z.number().int().min(0).max(100).default(0),
  minBookingNoticeHours: z.number().int().min(0).max(168).default(2),
  allowOverbooking: z.boolean().default(false),
  onlineBookingEnabled: z.boolean().default(true),
  branding: z.object({
    logoUrl: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
})

export const RoleKeySchema = z.enum([
  'SUPER_ADMIN', 'TENANT_ADMIN', 'RECEPTIONIST',
  'GROOMER', 'BATHER', 'VET', 'DRIVER', 'TUTOR',
])

export const CreateInvitationSchema = z.object({
  email: z.string().email(),
  role: RoleKeySchema.exclude(['SUPER_ADMIN', 'TUTOR']),
})

export const TenantResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(['PROVISIONING','TRIAL','ACTIVE','PAST_DUE','SUSPENDED','TERMINATED','PROVISIONING_FAILED']),
  plan: z.enum(['STARTER','PRO','ENTERPRISE']),
  onboardingStep: z.number().int().min(1).max(5),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
```

### Formato de Erro (application/problem+json)

```json
{
  "type": "https://docs.petshopai.com/errors/ERR_IDENT_004",
  "title": "Conflito de recurso",
  "status": 409,
  "code": "ERR_IDENT_004",
  "detail": "Este endereço já está em uso.",
  "traceId": "01J9X...",
  "errors": [{ "field": "slug", "message": "Já existe um estabelecimento com este endereço" }]
}
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_IDENT_001 | 404 | Recurso não encontrado para este tenant |
| ERR_IDENT_002 | 422 | Dados de entrada inválidos (detalhe em `errors[]`) |
| ERR_IDENT_003 | 403 | Papel/permissão insuficiente |
| ERR_IDENT_004 | 409 | Conflito (slug duplicado, membership existente, último admin) |
| ERR_IDENT_005 | 401 | Token/assinatura de webhook inválidos |
| ERR_IDENT_006 | 410 | Convite expirado ou revogado |
| ERR_IDENT_007 | 402 | Limite do plano atingido ou tenant inadimplente |
| ERR_IDENT_008 | 423 | Tenant suspenso — operação bloqueada |

## 6. Máquinas de Estado

### Tenant — Status

```
PROVISIONING
  │
  ├─(provisionamento OK)──────────► TRIAL ──(assinatura paga)──► ACTIVE
  │                                   │                             │
  │                                   │                             ├─(fatura vencida D+1)──► PAST_DUE
  │                                   │                             │                            │
  │                                   └─(trial expirou sem pagar)──►│                            ├─(pagamento)──► ACTIVE
  │                                                                 │                            │
  │                                                                 │                            └─(D+15 sem pagar)──► SUSPENDED
  │                                                                 │                                                     │
  ├─(5 falhas)──► PROVISIONING_FAILED                               └─(solicitação do titular)──► TERMINATED ◄────────────┘
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| PROVISIONING | TRIAL | `tenant.criado` | E-mail boas-vindas (MOD-NOTIF) | ✓ |
| TRIAL | ACTIVE | `tenant.ativado` | E-mail confirmação de assinatura | ✓ |
| ACTIVE | PAST_DUE | `tenant.inadimplente` | E-mail + banner no admin | ✓ |
| PAST_DUE | SUSPENDED | `tenant.suspenso` | E-mail + bloqueio de operação | ✓ |
| SUSPENDED | ACTIVE | `tenant.reativado` | E-mail de reativação | ✓ |
| Qualquer | TERMINATED | `tenant.encerrado` | E-mail + agendamento de anonimização D+30 | ✓ |

### Membership — Status

```
PENDING (convite) ──(aceite)──► ACTIVE ──(suspensão pelo admin)──► SUSPENDED ──(reativação)──► ACTIVE
       │                           │                                   │
       ├─(expira 7d)──► EXPIRED    └─(remoção)──► REMOVED ◄────────────┘
       └─(revogado)───► REVOKED
```

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Usuário pertence a múltiplos tenants | Permitido. O JWT carrega exatamente **um** `tenant_id` ativo por vez; a troca exige `switch-tenant` e gera novo par de tokens. Nenhuma query jamais cruza tenants. | MOD-IDENT, todos |
| RN-02 | Tenant precisa de ao menos um TENANT_ADMIN | Remoção/rebaixamento do último admin é bloqueada com 409 | MOD-IDENT |
| RN-03 | Papel alterado com sessão ativa | `permVersion` incrementa em `memberships`; gateway compara com o claim do token e força refresh na divergência | MOD-IDENT, MOD-SEC |
| RN-04 | Tenant suspenso | Escrita bloqueada com 423; leitura de dados próprios e exportação LGPD permanecem liberadas; site público continua no ar | MOD-IDENT, MOD-SITE, MOD-SEC |
| RN-05 | Papel TUTOR nunca é membership de operação | Tutores autenticam no Portal e são resolvidos por `tutor_id`, não por `membership`. Nenhum endpoint de admin aceita papel TUTOR. | MOD-PORTAL, MOD-TUTOR |
| RN-06 | Membership de profissional | Ao atribuir papel GROOMER/BATHER/VET/DRIVER, o sistema cria/reativa o registro correspondente em `professionals` (MOD-AGENDA) via evento | MOD-AGENDA, MOD-TAXI |
| RN-07 | Remoção de membership com agenda futura | Bloqueia com 409 listando os agendamentos pendentes; exige reatribuição ou cancelamento prévio | MOD-AGENDA |
| RN-08 | Concorrência na criação de slug | Índice único + captura de violação → 409 com sugestões. Nunca `SELECT` seguido de `INSERT` sem constraint. | MOD-IDENT, MOD-SITE |
| RN-09 | Webhook Clerk fora de ordem | Aplicar somente se `payload.updated_at > users.clerk_synced_at`; idempotência por `svix_id` | MOD-IDENT |
| RN-10 | Super Admin acessando dados do tenant | Acesso a dados de negócio exige justificativa textual + `support_access_grant` ativo; toda leitura é auditada individualmente | MOD-ADMIN, MOD-SEC |
| RN-11 | Limite de usuários por plano | STARTER 5, PRO 15, ENTERPRISE ilimitado. Verificação no convite e no aceite (o aceite pode ocorrer após downgrade). | MOD-ADMIN |
| RN-12 | E-mail alterado no Clerk | Atualiza `email` e `email_hash`; se o novo e-mail colidir com outro usuário, o webhook falha para DLQ e alerta o Super Admin | MOD-IDENT |

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX `petshop.events.dlx` com backoff exponencial (1s, 5s, 30s, 5min) e descarte para DLQ após 4 tentativas.

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `tenant.criado` | identity-service | notification, platform-admin, tenant-site, audit | `{ tenantId, slug, plan, adminUserId, timestamp }` |
| `tenant.onboarding.concluido` | identity-service | platform-admin, crm-automation, audit | `{ tenantId, durationSeconds, stepsSkipped[], timestamp }` |
| `tenant.ativado` / `tenant.suspenso` / `tenant.reativado` / `tenant.encerrado` | identity-service | todos os serviços, notification, audit | `{ tenantId, previousStatus, newStatus, reason, timestamp }` |
| `tenant.configuracao.atualizada` | identity-service | scheduling, crm-automation, tenant-site, audit | `{ tenantId, changedKeys[], timestamp }` |
| `membership.criado` | identity-service | scheduling (cria professional), notification, audit | `{ tenantId, userId, roleKey, isProfessional, timestamp }` |
| `membership.papel_alterado` | identity-service | scheduling, audit | `{ tenantId, userId, fromRole, toRole, actorUserId, timestamp }` |
| `membership.removido` | identity-service | scheduling, taxidog, audit | `{ tenantId, userId, roleKey, timestamp }` |
| `usuario.sincronizado` | identity-service | audit | `{ userId, clerkUserId, changedFields[], timestamp }` |

## 9. Segurança & LGPD

### Matriz de Permissões Base (referência para todos os módulos)

| Operação | Super Admin | Tenant Admin | Recepção | Banhista | Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|---|
| Configurar tenant | ✓ | ✓ | — | — | — | — | — | — |
| Convidar/remover equipe | ✓ | ✓ | — | — | — | — | — | — |
| Tutores — ler | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | parcial¹ | próprio |
| Tutores — criar/editar | ✓ | ✓ | ✓ | — | — | ✓ | — | próprio |
| Tutores — excluir | ✓ | ✓ | — | — | — | — | — | — |
| Pets — ler | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | parcial¹ | próprios |
| Pets — criar/editar | ✓ | ✓ | ✓ | — | — | ✓ | — | próprios |
| Prontuário — ler | ✓ | ✓ | resumo² | alertas³ | alertas³ | ✓ | alertas³ | resumo² |
| Prontuário — escrever | ✓ | ✓ | — | observações | observações | ✓ | — | — |
| Financeiro — ler | ✓ | ✓ | ✓ | — | — | — | — | próprio |
| Financeiro — lançar | ✓ | ✓ | ✓ | — | — | — | — | — |
| Financeiro — estornar | ✓ | ✓ | — | — | — | — | — | — |
| Agenda — ler todas | ✓ | ✓ | ✓ | própria | própria | própria | — | próprios |
| Agenda — criar/editar | ✓ | ✓ | ✓ | própria | própria | própria | — | próprios⁴ |
| Check-in/check-out | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| Taxi Dog — operar | ✓ | ✓ | ✓ | — | — | — | ✓ | — |
| Campanhas/CRM | ✓ | ✓ | ✓ | — | — | — | — | — |
| Site do tenant | ✓ | ✓ | — | — | — | — | — | — |
| Auditoria — ler | ✓ | ✓ | — | — | — | — | — | — |

¹ Motorista vê apenas nome, telefone e endereço dos tutores das corridas atribuídas a ele.
² Resumo = histórico de serviços e alertas, sem laudos e prescrições clínicas.
³ Alertas = temperamento e alergias (segurança do profissional), sem histórico clínico.
⁴ Tutor cria agendamentos apenas via Portal, respeitando disponibilidade e antecedência mínima.

### Audit Log — ações que DEVEM gerar registro imutável

- `tenant.created`, `tenant.status_changed`, `tenant.settings_updated` → `action`, `entity`, `entityId`, `actorUserId`, `tenantId`, `before`, `after`, `ipAddress`
- `membership.created`, `membership.role_changed`, `membership.removed`
- `invitation.created`, `invitation.revoked`, `invitation.accepted`
- `auth.login_failed`, `auth.permission_denied`, `auth.cross_tenant_attempt`
- `session.tenant_switched`
- `support.impersonation_started`, `support.impersonation_ended`

`audit_logs` é append-only: `REVOKE UPDATE, DELETE ON audit_logs FROM app_user;` + trigger `BEFORE UPDATE OR DELETE` que levanta exceção.

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| users.full_name | Dado pessoal | Execução de contrato | Vínculo ativo + 5 anos | ✓ | ✓ (anonimização) |
| users.email | Dado pessoal | Execução de contrato | Vínculo ativo + 5 anos | ✓ | ✓ (anonimização) |
| users.phone | Dado pessoal | Execução de contrato | Vínculo ativo + 5 anos | ✓ | ✓ |
| tenants.cnpj | Dado cadastral PJ | Obrigação legal (fiscal) | 5 anos após encerramento | ✓ | — |
| audit_logs.ip_address | Dado pessoal | Legítimo interesse (segurança) | 6 meses (Marco Civil: mínimo 6 meses) | ✓ | — |
| audit_logs (registro) | Metadado | Obrigação legal | 5 anos | ✓ | — |

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Configurações do tenant | 600s | `tenant:settings:{tenantId}` | `tenant.configuracao.atualizada` |
| Permissões efetivas do usuário | 300s | `perm:{tenantId}:{userId}` | `membership.papel_alterado`, `membership.removido` |
| Resolução slug → tenantId | 3600s | `tenant:slug:{slug}` | `tenant.criado`, alteração de slug |
| Status do tenant (gate de bloqueio) | 60s | `tenant:status:{tenantId}` | Qualquer transição de status |
| JWKS do Clerk | 3600s | `clerk:jwks` | TTL |

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "tenant_onboarding_completed", "tenantId": "...", "value": 412, "unit": "seconds" }
```

- `tenant_provisioning_duration`: tempo entre `POST /v1/tenants` e status TRIAL — por criação; alvo p95 < 8s
- `tenant_onboarding_completed`: duração total do wizard — por conclusão; alvo mediana < 10 min
- `tenant_onboarding_drop_step`: etapa em que o wizard foi abandonado — diário
- `auth_permission_denied_total`: negações por papel e rota — contínuo; pico indica matriz mal calibrada
- `cross_tenant_attempt_total`: **alerta imediato ao Super Admin em qualquer ocorrência**
- `clerk_webhook_lag_ms`: diferença entre `payload.timestamp` e processamento — alvo p95 < 3s
- `active_seats_per_tenant`: memberships ativos vs. limite do plano — diário (insumo de upsell)

### SLOs

| Endpoint | p95 | Disponibilidade |
|---|---|---|
| `GET /v1/me` | 120ms | 99,9% |
| `POST /v1/sessions/switch-tenant` | 250ms | 99,9% |
| `POST /v1/webhooks/clerk` | 400ms | 99,5% |
| Verificação de permissão no gateway | 15ms (cache hit) | 99,95% |

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Multi-unidade: franquia com 3 lojas = 3 tenants ou 1 tenant com N unidades? Assumido **3 tenants** na v1 (usuário com N memberships). | MOD-IDENT, MOD-AGENDA, MOD-LEDGER, precificação | PM + Tech Lead | Antes da Fase 3 |
| 2 | RBAC customizável pelo tenant (criar papéis próprios) — v1 entrega papéis fixos | MOD-IDENT, MOD-SEC | PM | Fase 7 |
| 3 | Duração do trial (assumido 14 dias) e o que acontece com os dados após expiração sem conversão | MOD-IDENT, MOD-ADMIN | PM comercial | Antes do lançamento |
| 4 | MFA obrigatório também para RECEPTIONIST? SPEC §7.1 diz "recomendado" para operacionais | MOD-SEC, UX de balcão | Tech Lead + PM | Fase 7 |
| 5 | Tenant Enterprise em banco dedicado — critério de corte e processo de migração | MOD-IDENT, infra | Tech Lead | Pós-MVP |
| 6 | Retenção de `ip_address` em audit_logs: 6 meses (Marco Civil) vs. 12 meses (forense) | MOD-SEC, custo de storage | DPO | Fase 7 |
