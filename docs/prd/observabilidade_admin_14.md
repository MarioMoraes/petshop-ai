# PRD Detalhado — Observabilidade e Administração da Plataforma

**Módulo:** MOD-ADMIN
**Arquivo:** 14/15
**Prioridade:** P1
**Fase de Implementação:** Fase 7 — Segurança e Compliance avançada
**Serviço Backend:** nenhum serviço novo. `backend/app/src/modules/platform` (módulo do backend único) e uma leitura em `src/auth/session.ts`
**Tabelas Principais:** `platform_admins`, `support_access_grants`, `platform_metrics` (novas). `audit_logs`, `job_runs`, `tenants`, `messages` (lidas)
**Data:** 2026-09-09
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** A PetShop AI opera dezenas de petshops num processo só, e hoje
não tem como responder três perguntas que qualquer operação comercial faz toda semana:
*quantos tenants estão ativos e em que plano*, *o que quebrou desde ontem*, e *por que o
cliente do suporte diz que a mensagem não chegou*. O produto **produz** o material para
responder as três — a trilha de auditoria, os eventos de segurança, o histórico de jobs,
cinquenta e uma métricas de negócio — e não tem quem leia. Este módulo é o leitor.

**Ele é curto pela mesma razão que o MOD-SEC foi.** Observabilidade não foi tratada como
frente separada: cada módulo instrumentou a sua parte no caminho. O inventário do que
**já está no ar** e que este PRD **não** reespecifica:

| O que | Onde | Desde |
|---|---|---|
| Trilha de auditoria append-only, com redação por chave | `packages/service-kit/src/audit.ts` | MOD-IDENT-09 |
| Leitura da trilha e dos eventos de segurança, por tenant | `modules/security` (`GET /v1/audit-logs`) | MOD-SEC-05 |
| Expurgo de 24 meses da trilha, em lotes | `modules/security/retention.ts` | MOD-SEC-08 |
| Histórico de execução de job, com status, duração e erro | `job_runs`, `packages/job-scheduler` | MOD-AGENDA fatia 1 |
| Lease por nome de job, que dá exclusão mútua entre réplicas | `job_leases` | MOD-AGENDA fatia 1 |
| 51 métricas de negócio em log estruturado | `recordMetric` em 30 arquivos | MOD-IDENT-09 em diante |
| `GET /health` e `GET /ready` (o segundo consulta o Postgres) | `src/app.ts` | Gateway |
| Painel de mensagens com contagem por status e canal | `modules/messaging/queries.ts` | MOD-NOTIF-11 |
| Sino de pendências na topbar, por tenant | `frontend`, quatro contadores | MOD-SITE-08, MOD-CRM |
| Rate limit por tenant+usuário, por IP e por webhook | `src/app.ts` | Gateway, MOD-SEC-09 |

**As três descobertas que dão substância ao módulo.**

A primeira: **`SUPER_ADMIN` existe na matriz de permissões e não tem superfície nenhuma.**
`ROLE_PERMISSIONS.SUPER_ADMIN = PERMISSION_KEYS` está em
`packages/shared-types/src/permissions.ts` desde o MOD-IDENT-04, com um comentário
prometendo um `support_access_grant` que nunca foi escrito. Não há rota que o reconheça,
não há tabela que o registre, e **não há como alguém se tornar um** — o papel não é
membership de tenant, e `memberships.role_key` é o único lugar onde papel vive. É um papel
declarado e inalcançável: hoje a equipe da plataforma opera com `psql`.

A segunda: **as cinquenta e uma métricas de negócio não são somadas por ninguém.**
`recordMetric` grava `{ metric, tenantId, value, unit }` em log estruturado, e o formato foi
escolhido justamente para ser agregável. Não há coletor, não há série temporal, não há
tela. `receivables_overdue_cents` é calculada todo dia de madrugada, escrita numa linha de
log e perdida. O mesmo vale para `taxi_window_adherence_rate`, `pet_search_latency` e
`message_queue_stuck` — que é literalmente um alarme sem alarme.

A terceira: **`job_runs` acumula desde a primeira fatia e ninguém olha.** A tabela guarda
nome, início, fim, status, resultado e erro de cada execução dos dezenove jobs da grade.
Um `ledger.reconcile` que falha três noites seguidas não avisa ninguém; o sintoma aparece
semanas depois, como divergência de saldo que já contaminou extrato.

**Escopo desta fase.** Entra: o papel de plataforma com registro e trilha; o acesso ao dado
de tenant mediado por autorização com prazo; o painel de saúde da plataforma; a agregação
das métricas que já são emitidas; e os alertas sobre elas. **Não** entra: cobrança do SaaS
aos tenants (o produto não tem gateway de pagamento próprio, e `tenants.plan` é hoje um
rótulo sem fatura atrás); tracing distribuído (o processo é um só desde a fatia 11, e o
`request_id` já correlaciona o que existe); e impersonation de sessão (MOD-IDENT-11, Nice
to Have, que é outra coisa que o grant desta fase **não** concede).

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-ADMIN-01 | Papel de Plataforma | Registro de quem é da equipe PetShop AI, fora de `memberships`, com concessão e revogação auditadas | Must Have |
| MOD-ADMIN-02 | Acesso de Suporte Consentido | Grant com motivo e prazo que o admin do tenant aprova para liberar leitura de dado de negócio | Must Have |
| MOD-ADMIN-03 | Painel de Tenants | Lista de estabelecimentos com plano, status, uso e data do último acesso | Must Have |
| MOD-ADMIN-04 | Saúde da Plataforma | Estado das dependências, grade de jobs e profundidade das filas de mensagem | Must Have |
| MOD-ADMIN-05 | Coletor de Métricas | Agregação das 51 métricas já emitidas em série temporal consultável | Must Have |
| MOD-ADMIN-06 | Alertas Operacionais | Regras sobre a série temporal e o histórico de jobs, com destino de notificação | Should Have |
| MOD-ADMIN-07 | Painel de Uso por Tenant | Contagens que sustentam a conversa comercial: tutores, pets, atendimentos, mensagens | Should Have |
| MOD-ADMIN-08 | Trilha da Plataforma | A leitura cross-tenant da trilha, que o MOD-SEC-05 deliberadamente não deu | Should Have |

---

## 3. Critérios de Aceite

### [MOD-ADMIN-01] — Papel de Plataforma

**AC-01 (Happy Path)**
- **Dado** que existe uma linha em `platform_admins` para o usuário, com `revoked_at IS NULL`
- **Quando** ele apresenta um token do Clerk **sem Organization** e chama `GET /platform/v1/tenants`
- **Então** o sistema resolve o contexto com `role = 'SUPER_ADMIN'` e as permissões de
  `ROLE_PERMISSIONS.SUPER_ADMIN`, e responde **200** com a lista de todos os tenants

**AC-02 (Validação / Erro)**
- **Dado** um usuário autenticado sem linha em `platform_admins`
- **Quando** chama qualquer rota sob `/platform/v1`
- **Então** recebe **404** `ERR_ADMIN_001` — e **não** 403. A superfície da plataforma não
  confirma a própria existência a quem não é dela

**AC-03 (Edge Case — o admin que também é dono de petshop)**
- **Dado** um `platform_admin` que **também** tem `membership` num tenant
- **Quando** apresenta um token **com** Organization ativa
- **Então** a sessão resolve como membership daquele tenant, com o papel de lá — o crachá de
  plataforma **não** amplia o que ele vê no Admin do próprio petshop. O caminho de
  plataforma exige token sem Organization, como o Portal exige o header de host

**AC-04 (Concessão)**
- **Dado** um `platform_admin` ativo
- **Quando** envia `POST /platform/v1/admins` com `{ email }` de alguém que já tem espelho
  local em `users`
- **Então** a linha nasce com `granted_by` preenchido, entra em `audit_logs` com
  `tenant_id = NULL`, e a resposta é **201**

**AC-05 (Edge Case — o último admin)**
- **Dado** que existe **um** `platform_admin` ativo
- **Quando** ele tenta revogar a si mesmo
- **Então** recebe **409** `ERR_ADMIN_004` "A plataforma ficaria sem administrador". A mesma
  guarda do último `TENANT_ADMIN` (RN-06 de MOD-IDENT-04), pela mesma razão

**AC-06 (Semeadura)**
- **Dado** um banco recém-migrado, sem nenhum `platform_admin`
- **Quando** a migration roda com `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` definida
- **Então** a primeira linha nasce com `granted_by = NULL` e uma linha de trilha dizendo que
  veio do bootstrap. Sem a variável, a tabela nasce vazia e a superfície fica inalcançável
  até alguém semear por `psql` — que é o estado correto, e não um erro

### [MOD-ADMIN-02] — Acesso de Suporte Consentido

**AC-01 (Happy Path)**
- **Dado** um `platform_admin` ativo
- **Quando** envia `POST /platform/v1/tenants/:tenantId/support-access` com
  `{ reason: "chamado #482 — tutor relata recibo não recebido" }`
- **Então** nasce um `support_access_grant` com `status = REQUESTED`, `expires_at` nulo, o
  `TENANT_ADMIN` do tenant recebe uma notificação pelo MOD-NOTIF, e a resposta é **201**

**AC-02 (Aprovação)**
- **Dado** um grant em `REQUESTED`
- **Quando** o `TENANT_ADMIN` chama `POST /v1/support-access/:id/approve`
- **Então** o grant vai a `ACTIVE` com `approved_at = now()` e
  `expires_at = now() + SUPPORT_GRANT_HOURS` (padrão 24), publica `suporte.acesso.concedido`
  e entra na trilha **do tenant** — quem aprovou fica registrado no estabelecimento dele

**AC-03 (Validação / Erro)**
- **Dado** um `platform_admin` **sem** grant ativo naquele tenant
- **Quando** chama `GET /platform/v1/tenants/:tenantId/tutors`
- **Então** recebe **403** `ERR_ADMIN_002` "Este acesso precisa da autorização do
  estabelecimento", com o `grantUrl` para pedir. Nenhuma linha de negócio é lida

**AC-04 (Edge Case — o grant que venceu no meio da sessão)**
- **Dado** um grant `ACTIVE` cujo `expires_at` passou há um minuto
- **Quando** a próxima requisição chega
- **Então** ela é recusada como se não houvesse grant. **A checagem é por requisição, e lê
  `expires_at` do banco** — um grant que vence enquanto a tela está aberta para de valer na
  ação seguinte, não no próximo login

**AC-05 (Revogação pelo tenant)**
- **Dado** um grant `ACTIVE`
- **Quando** o `TENANT_ADMIN` chama `POST /v1/support-access/:id/revoke`
- **Então** o grant vai a `REVOKED` na hora, e a próxima leitura do suporte é recusada

**AC-06 (Toda leitura sob grant é registrada)**
- **Dado** um grant `ACTIVE`
- **Quando** o suporte abre a ficha de um tutor
- **Então** entra uma linha em `audit_logs` **do tenant**, com
  `action = 'support.read'`, `actor_user_id` do suporte e o `grant_id` no `after` — visível
  na tela de auditoria que o MOD-SEC-05 entregou ao próprio tenant

**AC-07 (Edge Case — o que o grant nunca libera)**
- **Dado** um grant `ACTIVE`
- **Quando** o suporte tenta qualquer **escrita** (`POST`, `PATCH`, `PUT`, `DELETE`) numa
  rota `/v1`
- **Então** recebe **403** `ERR_ADMIN_003`. O grant é de **leitura**. Suporte que precisa
  corrigir dado pede ao estabelecimento que corrija, ou abre chamado de engenharia — um
  terceiro escrevendo na ficha do cliente é indefensável na primeira reclamação

### [MOD-ADMIN-03] — Painel de Tenants

**AC-01 (Happy Path)**
- **Dado** um `platform_admin` ativo
- **Quando** chama `GET /platform/v1/tenants?status=ACTIVE&page=1&limit=20`
- **Então** recebe **200** com `{ data, total, page, limit }`, cada item trazendo `slug`,
  `name`, `status`, `plan`, `trialEndsAt`, `createdAt`, `lastActivityAt` e as contagens do
  MOD-ADMIN-07 — **sem nenhum dado pessoal de tutor ou pet**

**AC-02 (Edge Case — tenant travado no provisionamento)**
- **Dado** um tenant em `PROVISIONING_FAILED`
- **Quando** o painel é aberto
- **Então** ele aparece no topo, com a contagem de tentativas e o erro da última — é o único
  estado em que o produto precisa de intervenção humana da plataforma para destravar

**AC-03 (Validação / Erro)**
- **Dado** um `platform_admin`
- **Quando** pede `?status=INVENTADO`
- **Então** recebe **422** `ERR_ADMIN_005` com a lista dos valores aceitos

### [MOD-ADMIN-04] — Saúde da Plataforma

**AC-01 (Happy Path)**
- **Dado** um `platform_admin`
- **Quando** chama `GET /platform/v1/health`
- **Então** recebe **200** com o estado de Postgres, Redis, RabbitMQ e Gotenberg (cada um
  com latência e `ok`), a grade de jobs (última execução, status, duração, próxima
  prevista), e a profundidade das filas de mensagem por status

**AC-02 (Edge Case — dependência fora)**
- **Dado** que o Redis não responde
- **Quando** o painel é aberto
- **Então** a resposta é **200** com `redis.ok = false` e o erro, e as demais seções
  preenchidas. **A tela de saúde não pode cair junto com o que ela observa** — um 503 aqui
  diz muito menos que uma linha vermelha

**AC-03 (Job que não roda há tempo demais)**
- **Dado** um job cuja última execução bem-sucedida é mais antiga que **três vezes** o
  intervalo do cron dele
- **Quando** o painel é aberto
- **Então** ele aparece como `STALE`, e não como "ok, última execução há 3 dias". O
  múltiplo evita alarme por atraso de uma passada

**AC-04 (Edge Case — lease órfão)**
- **Dado** uma linha em `job_leases` cujo `lease_until` passou e nenhuma execução começou
  depois
- **Quando** o painel é aberto
- **Então** o job aparece marcado como lease preso, com o `holder` que o segurava. É o
  sintoma de réplica morta no meio de um job, e o único lugar onde ele é visível

### [MOD-ADMIN-05] — Coletor de Métricas

**AC-01 (Happy Path)**
- **Dado** que `recordMetric` é chamado em qualquer módulo
- **Quando** o job `platform.roll-up-metrics` roda (de cinco em cinco minutos)
- **Então** os valores do período viram uma linha por `(metric, tenant_id, bucket)` em
  `platform_metrics`, com `sum`, `count`, `min`, `max` e `p95`

**AC-02 (Consulta)**
- **Dado** métricas acumuladas
- **Quando** o suporte chama
  `GET /platform/v1/metrics?metric=messages_dispatched&from=…&to=…&groupBy=tenant`
- **Então** recebe a série no intervalo, agregada pelo bucket que couber na janela pedida

**AC-03 (Edge Case — métrica sem tenant)**
- **Dado** `mfa_claim_missing`, que às vezes é emitida sem `tenantId`
- **Quando** o roll-up roda
- **Então** a linha nasce com `tenant_id = NULL` e aparece na consulta como "plataforma". A
  ausência de tenant é informação, não erro

**AC-04 (Retenção)**
- **Dado** buckets de cinco minutos com mais de **trinta dias**
- **Quando** o job `platform.compact-metrics` roda
- **Então** eles são consolidados em buckets de um dia, e os originais apagados. A série
  diária é mantida por **treze meses**, para comparar com o mesmo mês do ano anterior

**AC-05 (Edge Case — o coletor não pode custar mais que o que mede)**
- **Dado** um pico de tráfego
- **Quando** o roll-up roda
- **Então** ele lê do próprio processo, não do arquivo de log: `recordMetric` passa a
  **acumular em memória** e o job drena o acumulador. Nenhuma escrita por métrica, nenhum
  parser de log, nenhum I/O no caminho quente

### [MOD-ADMIN-06] — Alertas Operacionais

**AC-01 (Happy Path)**
- **Dado** uma regra `message_queue_stuck > 0 por 15 minutos`
- **Quando** a condição se mantém em duas avaliações seguidas
- **Então** nasce um alerta, o destino configurado recebe a mensagem pelo MOD-NOTIF, e o
  alerta fica `FIRING` até a condição deixar de valer

**AC-02 (Edge Case — o alerta que não pode depender do que quebrou)**
- **Dado** que o RabbitMQ está fora
- **Quando** a regra de fila dispara
- **Então** a notificação sai por **e-mail**, e não pela fila. Um alarme que usa o
  componente quebrado para avisar que ele quebrou não é alarme

**AC-03 (Resolução automática)**
- **Dado** um alerta `FIRING`
- **Quando** a condição deixa de valer por duas avaliações
- **Então** ele vai a `RESOLVED` e o destino recebe o aviso. Alerta que só acende treina
  a equipe a ignorar painel

**AC-04 (Edge Case — tempestade)**
- **Dado** que trinta tenants disparam a mesma regra no mesmo minuto
- **Quando** os alertas nascem
- **Então** sai **uma** notificação com a contagem e os cinco primeiros tenants, não trinta.
  O agrupamento é por regra, com janela de cinco minutos

### [MOD-ADMIN-07] — Painel de Uso por Tenant

**AC-01 (Happy Path)**
- **Dado** um `platform_admin`
- **Quando** chama `GET /platform/v1/tenants/:tenantId/usage`
- **Então** recebe contagens de tutores ativos, pets ativos, atendimentos nos últimos 30
  dias, mensagens enviadas no mês, documentos emitidos e bytes de foto — **sem grant**,
  porque contagem não é dado pessoal

**AC-02 (Edge Case — a fronteira do que é contagem)**
- **Dado** um tenant com **um** tutor
- **Quando** o painel de uso é aberto
- **Então** ele mostra `tutores: 1` e nada mais. A contagem não vira identificação nem
  quando o denominador é um: nome, telefone e e-mail continuam atrás do grant

### [MOD-ADMIN-08] — Trilha da Plataforma

**AC-01 (Happy Path)**
- **Dado** um `platform_admin`
- **Quando** chama `GET /platform/v1/audit-logs?action=support.read&from=…&to=…`
- **Então** recebe as linhas de **todos** os tenants, paginadas por cursor, com a mesma
  janela máxima de 92 dias do MOD-SEC-05

**AC-02 (Edge Case — a trilha do próprio suporte)**
- **Dado** que o suporte leu fichas sob grant
- **Quando** outro `platform_admin` filtra por `actor_user_id` dele
- **Então** vê o que ele leu, em que tenant e sob qual grant. **Quem vigia também é
  vigiado**, e essa é a única razão pela qual a leitura cross-tenant existe

**AC-03 (Validação / Erro)**
- **Dado** um `platform_admin`
- **Quando** pede uma janela de 200 dias
- **Então** recebe **422** `ERR_ADMIN_005`, como no MOD-SEC-05

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| `platform_admins` | `id` | `String @db.Uuid` | ✓ | PK |
| `platform_admins` | `user_id` | `String @db.Uuid` | ✓ | FK para `users`. **Único**, e sem `tenant_id`: o papel é da plataforma |
| `platform_admins` | `granted_by` | `String? @db.Uuid` | — | Quem concedeu. Nulo só na linha de bootstrap |
| `platform_admins` | `granted_at` | `DateTime @db.Timestamptz(6)` | ✓ | |
| `platform_admins` | `revoked_at` | `DateTime? @db.Timestamptz(6)` | — | Revogação é soft: a linha fica para a trilha |
| `platform_admins` | `revoked_by` | `String? @db.Uuid` | — | |
| `support_access_grants` | `id` | `String @db.Uuid` | ✓ | PK |
| `support_access_grants` | `tenant_id` | `String @db.Uuid` | ✓ | O estabelecimento que autoriza |
| `support_access_grants` | `admin_user_id` | `String @db.Uuid` | ✓ | Quem do suporte pediu |
| `support_access_grants` | `reason` | `String @db.VarChar(300)` | ✓ | Vai na notificação ao tenant; é o que ele lê para decidir |
| `support_access_grants` | `status` | `SupportGrantStatus` | ✓ | `REQUESTED` / `ACTIVE` / `DENIED` / `EXPIRED` / `REVOKED` |
| `support_access_grants` | `approved_by` | `String? @db.Uuid` | — | O `TENANT_ADMIN` que aprovou |
| `support_access_grants` | `approved_at` | `DateTime?` | — | |
| `support_access_grants` | `expires_at` | `DateTime?` | — | Preenchido na aprovação, nunca no pedido |
| `platform_metrics` | `id` | `String @db.Uuid` | ✓ | PK |
| `platform_metrics` | `metric` | `String @db.VarChar(60)` | ✓ | O nome que `recordMetric` emite |
| `platform_metrics` | `tenant_id` | `String? @db.Uuid` | — | Nulo é métrica de plataforma |
| `platform_metrics` | `bucket` | `DateTime @db.Timestamptz(6)` | ✓ | Início da janela |
| `platform_metrics` | `resolution` | `MetricResolution` | ✓ | `FIVE_MIN` / `DAY` |
| `platform_metrics` | `sum`, `count`, `min`, `max`, `p95` | `Decimal` / `Int` | ✓ | |
| `platform_alerts` | `rule`, `tenant_id`, `status`, `fired_at`, `resolved_at`, `value` | — | ✓ | O estado de cada regra |

**`platform_admins` e `platform_metrics` não têm `tenant_id`, e é por isso que ficam fora
do RLS** — como `users`, `species` e os demais cadastros globais. `support_access_grants`
**tem** `tenant_id` e entra no RLS normalmente: o estabelecimento precisa enxergar e revogar
os próprios grants pela tela do MOD-SEC.

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| — | — | **Nenhum.** Este módulo não guarda dado pessoal: guarda quem é da equipe, quem autorizou o quê e quantos de cada coisa existem. O `reason` do grant é texto do suporte sobre um chamado, e é justamente o que o tenant precisa **ler em claro** para decidir |

### Índices Necessários

```sql
CREATE UNIQUE INDEX idx_platform_admins_user ON platform_admins(user_id);
CREATE INDEX idx_platform_admins_ativos ON platform_admins(user_id) WHERE revoked_at IS NULL;

CREATE INDEX idx_grants_tenant_status ON support_access_grants(tenant_id, status);
-- O caminho quente: "este suporte tem grant vivo neste tenant?", uma vez por requisição.
CREATE INDEX idx_grants_vivos ON support_access_grants(admin_user_id, tenant_id, expires_at)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX idx_metrics_bucket
  ON platform_metrics(metric, resolution, bucket, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_metrics_consulta ON platform_metrics(metric, bucket DESC);
```

---

## 5. Contratos de API

Todos os endpoints exigem `Authorization: Bearer <jwt>` do Clerk. **As rotas sob
`/platform/v1` exigem token sem Organization ativa e linha viva em `platform_admins`** — o
mesmo desenho do `/portal/v1`, em que a superfície tem prefixo próprio porque tem resolução
de sessão própria. Paginação padrão `?page=1&limit=20`; a trilha pagina por cursor.

### Endpoints

| Método | Path | Quem | Descrição |
|---|---|---|---|
| GET | `/platform/v1/tenants` | Super Admin | Lista de estabelecimentos com plano, status e uso |
| GET | `/platform/v1/tenants/:id/usage` | Super Admin | Contagens do MOD-ADMIN-07 |
| POST | `/platform/v1/tenants/:id/support-access` | Super Admin | Pede acesso, com motivo |
| GET | `/platform/v1/health` | Super Admin | Dependências, jobs e filas |
| GET | `/platform/v1/metrics` | Super Admin | Série temporal |
| GET | `/platform/v1/audit-logs` | Super Admin | Trilha cross-tenant, por cursor |
| GET | `/platform/v1/alerts` | Super Admin | Alertas abertos e resolvidos |
| POST | `/platform/v1/admins` | Super Admin | Concede o papel |
| DELETE | `/platform/v1/admins/:id` | Super Admin | Revoga |
| GET | `/v1/support-access` | `tenant:configure` | Os grants **deste** tenant |
| POST | `/v1/support-access/:id/approve` | `tenant:configure` | Aprova, com prazo |
| POST | `/v1/support-access/:id/revoke` | `tenant:configure` | Revoga a qualquer momento |

**As três últimas moram em `/v1`, e não em `/platform/v1`**, porque quem as chama é o
administrador do petshop, na tela dele. É a mesma fronteira que separa `/portal/v1` do
Admin: o prefixo diz de quem é a superfície, não de que assunto ela trata.

### Schema Zod — pacote `@petshop/shared-types`

```typescript
import { z } from 'zod'

export const RequestSupportAccessSchema = z.object({
  /** Vai na notificação ao tenant. É o que ele lê para decidir se aprova. */
  reason: z.string().trim().min(10).max(300),
})
export type RequestSupportAccessInput = z.output<typeof RequestSupportAccessSchema>

export const ApproveSupportAccessSchema = z.object({
  /**
   * Prazo em horas. O tenant pode encurtar, nunca esticar: o teto é
   * `SUPPORT_GRANT_MAX_HOURS` e a validação é do servidor.
   */
  hours: z.coerce.number().int().min(1).max(72).default(24),
})

export const PlatformMetricsQuerySchema = z.object({
  metric: z.string().min(1).max(60),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  groupBy: z.enum(['tenant', 'total']).default('total'),
})

export const TenantListQuerySchema = z.object({
  status: z.enum(['PROVISIONING', 'PROVISIONING_FAILED', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'TERMINATED']).optional(),
  plan: z.enum(['STARTER', 'PRO', 'ENTERPRISE']).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const SupportGrantResponseSchema = z.object({
  id: z.uuid(),
  status: z.enum(['REQUESTED', 'ACTIVE', 'DENIED', 'EXPIRED', 'REVOKED']),
  reason: z.string(),
  requestedBy: z.object({ name: z.string(), email: z.string() }),
  approvedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| `ERR_ADMIN_001` | 404 | Rota de plataforma alcançada por quem não é da plataforma. **404, não 403** |
| `ERR_ADMIN_002` | 403 | Leitura de dado de tenant sem grant ativo |
| `ERR_ADMIN_003` | 403 | Escrita sob grant. O grant é de leitura, sempre |
| `ERR_ADMIN_004` | 409 | A plataforma ficaria sem administrador |
| `ERR_ADMIN_005` | 422 | Entrada inválida, ou janela maior que 92 dias |
| `ERR_ADMIN_006` | 409 | Grant em estado que não permite a transição pedida |

---

## 6. Máquinas de Estado

### `support_access_grants` — Status

```
REQUESTED
  │
  ├─(tenant aprova, define prazo)──────────► ACTIVE
  │                                            │
  │                                            ├─(expires_at passa)──────► EXPIRED
  │                                            │
  │                                            └─(tenant revoga)────────► REVOKED
  │
  ├─(tenant recusa)────────────────────────► DENIED
  │
  └─(72h sem resposta)─────────────────────► EXPIRED
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| — | `REQUESTED` | `suporte.acesso.solicitado` | e-mail ao `TENANT_ADMIN` | ✓ (tenant) |
| `REQUESTED` | `ACTIVE` | `suporte.acesso.concedido` | e-mail ao suporte | ✓ (tenant) |
| `REQUESTED` | `DENIED` | `suporte.acesso.negado` | e-mail ao suporte | ✓ (tenant) |
| `ACTIVE` | `REVOKED` | `suporte.acesso.revogado` | e-mail ao suporte | ✓ (tenant) |
| `ACTIVE` | `EXPIRED` | — | — | ✓ (tenant) |

**Não há transição de volta a `ACTIVE`.** Prazo vencido é grant novo, com motivo novo — o
que dá ao tenant a chance de perguntar por que o suporte precisa entrar de novo.

### `platform_alerts` — Status

```
(regra avaliada)
  │
  ├─(condição vale em 2 avaliações)──► FIRING ──(deixa de valer em 2)──► RESOLVED
  │
  └─(condição não vale)──────────────► (nada acontece)
```

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Rota de plataforma alcançada por quem não é da plataforma | **404**, e não 403. Um 403 confirmaria que a superfície existe a quem está varrendo | MOD-ADMIN, MOD-SEC |
| RN-02 | Super Admin sem grant pede dado de negócio | 403, e **nenhuma linha lida**. A checagem vem antes da consulta, não depois do filtro | MOD-ADMIN |
| RN-03 | Grant expira durante a sessão | A checagem é por requisição e lê `expires_at` do banco. Sem cache — sessenta segundos de grant vencido é sessenta segundos de acesso indevido | MOD-ADMIN |
| RN-04 | Grant nunca libera escrita | Toda rota `/v1` não-`GET` é recusada sob grant, sem exceção por módulo | MOD-ADMIN, todos |
| RN-05 | Papel de plataforma não se soma ao papel de tenant | Token **com** Organization resolve como membership; token **sem** Organization resolve como plataforma. Um login, dois contextos, nunca simultâneos | MOD-IDENT, MOD-ADMIN |
| RN-06 | A plataforma não fica sem administrador | Última revogação ativa é recusada com 409, como o último `TENANT_ADMIN` | MOD-ADMIN |
| RN-07 | Métrica é acumulada em memória, não lida de log | `recordMetric` soma num acumulador do processo; o job drena. Parsear log seria acoplar a observabilidade ao formato do transporte | MOD-ADMIN, todos |
| RN-08 | Acumulador perdido em reinício é perda aceita | Um deploy no meio de um bucket perde até cinco minutos de métrica. Persistir a cada chamada custaria uma escrita por métrica no caminho quente — o preço não se paga para telemetria | MOD-ADMIN |
| RN-09 | Réplicas somam, não sobrescrevem | O roll-up faz `INSERT … ON CONFLICT DO UPDATE SET sum = sum + excluded.sum`. Duas réplicas drenando o mesmo bucket somam; um `UPDATE SET sum =` perderia metade | MOD-ADMIN |
| RN-10 | Alerta não usa o que quebrou para avisar | Notificação de alerta sai por e-mail direto, fora da fila do MOD-NOTIF | MOD-ADMIN, MOD-NOTIF |
| RN-11 | Contagem não é identificação | O painel de uso responde números sem grant; nome, telefone e e-mail exigem grant, ainda que a contagem seja 1 | MOD-ADMIN, MOD-TUTOR |
| RN-12 | Job parado é medido em múltiplos do cron | `STALE` a partir de 3× o intervalo. Um múltiplo fixo em minutos alarmaria o job semanal e ignoraria o de 15 em 15 | MOD-ADMIN |
| RN-13 | A trilha da plataforma registra quem leu a trilha | `GET /platform/v1/audit-logs` gera a própria linha, com `tenant_id = NULL` | MOD-ADMIN, MOD-SEC |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange `petshop.events` (topic), DLX com backoff 1s/5s/30s/5min.

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `suporte.acesso.solicitado` | `modules/platform` | `messaging` | `{ tenantId, grantId, reason, requestedBy, timestamp }` |
| `suporte.acesso.concedido` | `modules/platform` | `messaging` | `{ tenantId, grantId, expiresAt, approvedBy, timestamp }` |
| `suporte.acesso.negado` | `modules/platform` | `messaging` | `{ tenantId, grantId, timestamp }` |
| `suporte.acesso.revogado` | `modules/platform` | `messaging` | `{ tenantId, grantId, revokedBy, timestamp }` |
| `plataforma.alerta.disparado` | `modules/platform` | — | `{ rule, tenantId, value, firedAt }` |

**Este módulo não consome evento nenhum**, e a ausência é uma decisão: as métricas vêm do
acumulador em memória, não do broker. Um consumidor de todos os eventos do sistema seria um
segundo caminho para a mesma informação, com atraso e com fila própria a monitorar.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin (sem grant) | Super Admin (com grant) | TENANT_ADMIN | Demais papéis |
|---|---|---|---|---|
| Listar tenants | ✓ | ✓ | — | — |
| Ver uso e contagens de um tenant | ✓ | ✓ | — | — |
| Saúde, métricas e alertas | ✓ | ✓ | — | — |
| Trilha cross-tenant | ✓ | ✓ | — | — |
| **Ler ficha de tutor, pet, prontuário, financeiro** | — | ✓ | ✓ (a própria) | conforme a matriz |
| **Escrever qualquer coisa em `/v1`** | — | — | ✓ | conforme a matriz |
| Conceder/revogar papel de plataforma | ✓ | ✓ | — | — |
| Aprovar/revogar grant do próprio tenant | — | — | ✓ | — |

**A coluna que importa é a quinta linha da terceira coluna: vazia.** O Super Admin nunca
escreve no dado de um estabelecimento, com ou sem autorização.

### Audit Log (tabela `audit_logs`)

Ações que **devem** gerar registro imutável:

- `platform.admin_granted` / `platform.admin_revoked` → `tenant_id = NULL`, com quem
  concedeu e para quem
- `support.requested` / `support.approved` / `support.denied` / `support.revoked` →
  **na trilha do tenant**, porque é ele quem precisa ver
- `support.read` → uma linha por leitura sob grant, com `grant_id`, rota e recurso
- `platform.audit_read` → a leitura da trilha cross-tenant, com o filtro usado

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `platform_admins.user_id` | Dado pessoal (vínculo profissional) | Contrato de trabalho | Enquanto houver vínculo + 5 anos | — | — |
| `support_access_grants.reason` | Dado operacional | Legítimo interesse | 24 meses (com a trilha) | ✓ ao tenant | — |
| `platform_metrics` | **Nenhum** — são contagens agregadas | — | 30 dias em 5 min, 13 meses em dia | — | — |
| Dado de tutor lido sob grant | Dado pessoal do titular | Legítimo interesse (suporte), com autorização do controlador | Não é copiado; só lido | Pelo tenant | Pelo tenant |

**O tenant é o controlador e a plataforma é a operadora** (art. 5º, VI e VII da LGPD). O
grant é a forma de o controlador autorizar cada acesso do operador ao dado dos titulares
dele, com motivo, prazo e registro — que é exatamente o que o art. 39 pede do contrato entre
os dois.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Vínculo de plataforma | 300s | `platform:admin:{userId}` | Concessão ou revogação |
| Painel de saúde | 15s | `platform:health` | Só por TTL |
| **Grant ativo** | **não entra em cache** | — | — |

**O grant fora do cache é a decisão de desenho deste módulo.** Todo o resto do produto
guarda permissão em cache por cinco minutos, e ali isso é aceitável: mudar papel é raro e
`permVersion` cobre a corrida. Aqui não: a revogação existe para o caso em que o tenant
**quer que pare agora**, e um cache de sessenta segundos daria ao suporte um minuto de acesso
depois do clique. O custo é uma consulta indexada por requisição, no caminho de uma
superfície que a equipe da plataforma usa — não o do balcão.

### Métricas de Negócio

```json
{ "metric": "support_grant_requested_total", "tenantId": "...", "value": 1, "unit": "count" }
```

- `support_grant_requested_total` / `support_grant_approved_total` — a razão entre as duas
  diz se o suporte pede acesso demais, ou se o produto obriga a pedir para tarefa que
  deveria ser autoatendida
- `support_read_total` — leituras sob grant, por tenant
- `platform_metric_rollup_duration` — o coletor não pode virar o gargalo que ele mede
- `platform_alert_firing_total` — alerta em `FIRING` por regra; a série é o que separa
  regra útil de regra ruidosa

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | O painel de saúde precisa de tela, ou basta a API nesta fase? | Frontend da plataforma é superfície nova, com layout próprio | PM | Antes da implementação |
| 2 | `SUPPORT_GRANT_MAX_HOURS` de 72h é teto adequado? | Chamado que atravessa fim de semana pode exigir mais | PM / Suporte | Antes da implementação |
| 3 | Alerta notifica por e-mail para quem? Lista fixa em ambiente, ou os `platform_admins` ativos? | A segunda muda o destino junto com a equipe, sem deploy | Tech Lead | Antes da implementação |
| 4 | Cobrança do SaaS ao tenant fica para quando? | `tenants.plan` é rótulo sem fatura; o painel de uso é o insumo dela | PM | Fase própria |
| 5 | Impersonation (MOD-IDENT-11) usa este grant ou outro mecanismo? | Assumir sessão é diferente de ler dado, e merece prazo mais curto | PM / Tech Lead | Fase própria |
| 6 | O bootstrap por variável de ambiente vale só em desenvolvimento? | Em produção, semear por `psql` deixa rastro no acesso ao banco, não na trilha | Tech Lead | Antes da implementação |
