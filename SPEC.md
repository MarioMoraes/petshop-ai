# SPEC — PetShop AI
### Especificação Técnica (Documento Mestre)

| Campo | Valor |
|---|---|
| Sistema | PetShop AI |
| Tipo | Micro-SaaS Multi-tenant, arquitetura de microserviços |
| Versão do documento | 1.0 |
| Documento irmão | PRD.md |
| Escopo | Visão macro de arquitetura — base para SPECs individuais por serviço/módulo |

---

## 1. Visão Geral da Arquitetura

O PetShop AI é construído como um **monorepo** contendo frontend, landing page, backend (microserviços) e mobile, permitindo compartilhamento de tipos, contratos de API e componentes, com pipelines de build/deploy independentes por app/serviço.

```
petshop-ai/
├── landingpage/          # Site institucional do PRODUTO PetShop AI (marketing do SaaS em si)
├── frontend/              # Next.js — Admin do tenant + Portal do Tutor (web)
├── backend/               # Microserviços (Node.js/TypeScript)
├── mobile/                # App mobile (preparado; React Native sugerido por reuso com React/TS)
├── packages/               # Código compartilhado (types, sdk-client, ui-kit, config)
│   ├── shared-types/
│   ├── api-client/
│   ├── ui/
│   └── config/
├── infra/                 # IaC, docker-compose, stacks Swarm/K8s, CI/CD
└── docs/                  # PRDs, SPECs, ADRs
```

> Nota: cada petshop (tenant) possui um **site público** (módulo 7.9 do PRD), que é gerado/servido dinamicamente a partir do `frontend` (rotas multi-tenant por domínio/subdomínio) — não é um app separado no monorepo, e sim uma capacidade do `frontend`. O `landingpage` do monorepo refere-se ao site de marketing do **produto PetShop AI**, para aquisição de novos tenants.

### 1.1 Estilo arquitetural
- **Backend:** microserviços, comunicação síncrona via REST/HTTP (e possivelmente gRPC entre serviços internos), comunicação assíncrona via fila de mensagens (a definir: ex. RabbitMQ/Redis Streams) para eventos (ex.: "agendamento criado" → dispara lembrete WhatsApp).
- **Frontend:** Next.js (App Router) + React + TypeScript, SSR/ISR para o site público do tenant (SEO), CSR para área logada (admin e portal).
- **Mobile:** app preparado para consumir os mesmos endpoints (API-first), autenticação via Clerk.
- **API Gateway:** ponto único de entrada para o frontend/mobile, responsável por roteamento aos microserviços, autenticação/validação de tenant, rate limiting.

---

## 2. Decomposição em Microserviços

| Serviço | Responsabilidade | Módulo PRD relacionado |
|---|---|---|
| **identity-service** | Tenants, usuários, papéis (RBAC), integração Clerk | 7.1 |
| **tutor-service** | CRUD de tutores, segmentação/tags | 7.1 |
| **pet-service** | CRUD de pets, cadastros auxiliares (espécie/raça/porte/pelagem), álbum de fotos | 7.2 |
| **medical-record-service** | Prontuário: histórico de atendimentos, temperamento, alergias | 7.3 |
| **billing-ledger-service** | Conta corrente do tutor (débitos/créditos), extrato | 7.4 |
| **scheduling-service** | Agenda por profissional, recorrência, check-in/out | 7.5 |
| **taxidog-service** | Logística leva-e-traz vinculada à agenda | 7.6 |
| **crm-automation-service** | Regras de campanha, aniversário, inatividade, orquestração de disparo | 7.7 |
| **messaging-service** | Integração WhatsApp (envio/recebimento), fila de mensagens | 7.7 |
| **notification-service** | Integração Resend (e-mail transacional) | 7.11 |
| **document-service** | Integração Gotenberg (geração de PDF) | 7.10 |
| **tenant-site-service** | Configuração/conteúdo do site público por tenant | 7.9 |
| **portal-bff** | Backend-for-Frontend do Portal do Tutor (agregação de dados) | 7.8 |
| **admin-bff** | Backend-for-Frontend do Admin do tenant | Transversal |
| **audit-service** | Registro de auditoria centralizado (event sourcing de ações sensíveis) | 7.13 |
| **platform-admin-service** | Visão Super Admin: billing de tenants, saúde da plataforma | 7.13 |
| **(futuro) agent-orchestrator-service** | Orquestração dos agentes de IA (tools sobre os serviços acima) | 7.14 |

> Cada serviço acima deve possuir seu **próprio SPEC de módulo**, com modelo de dados detalhado, contratos de API (OpenAPI) e regras de negócio.

### 2.1 Padrão de comunicação entre serviços
- **Síncrona (request/response):** via REST interno (JSON), autenticado por token de serviço (service-to-service), sempre carregando `tenant_id` no contexto da requisição.
- **Assíncrona (eventos de domínio):** via broker de mensagens (ex.: `agendamento.criado`, `pagamento.registrado`, `pet.aniversario`), consumidos por `crm-automation-service`, `messaging-service`, `audit-service`.
- Cada serviço possui seu próprio banco de dados lógico (schema), respeitando o princípio de *database-per-service* dentro do PostgreSQL compartilhado (ver seção 4).

---

## 3. Estratégia de Multi-tenancy

### 3.1 Modelo de isolamento de dados
Estratégia recomendada: **Row-Level (coluna `tenant_id`) com Row-Level Security (RLS) do PostgreSQL habilitado em todas as tabelas de negócio**, combinando:
- Simplicidade operacional de um único cluster PostgreSQL (vs. schema-per-tenant, que dificulta migrações em escala).
- Segurança reforçada por RLS: mesmo em caso de bug de aplicação, o banco impede vazamento entre tenants.
- Alternativa a avaliar para tenants Enterprise/grande volume: schema dedicado ou banco dedicado (isolamento físico), mantendo a mesma aplicação — decisão a ser tomada em SPEC de módulo de Identity/Tenancy.

**Regras obrigatórias:**
- Toda tabela de negócio possui `tenant_id UUID NOT NULL` com índice.
- Toda query passa pelo contexto de tenant resolvido na autenticação (nunca confiar em `tenant_id` vindo do client sem validação).
- RLS policies no PostgreSQL usando `current_setting('app.tenant_id')`, setado por transação/conexão no início de cada request.
- Cadastros verdadeiramente globais (ex.: tabela mestre de espécies/raças, se compartilhada entre tenants) ficam em tabelas sem `tenant_id`, claramente segregadas do restante do domínio.

### 3.2 Resolução de tenant
- Admin/Portal: resolvido via subdomínio ou domínio customizado (ex.: `joaopetshop.petshopai.app`) + claim de tenant no token Clerk (organização Clerk = tenant).
- Site público do tenant: resolvido via domínio/subdomínio no `tenant-site-service`.
- API: `tenant_id` derivado do token JWT (nunca de parâmetro de URL/body sem validação cruzada).

### 3.3 Modelo Clerk ↔ Tenant
- Recomendação: usar o conceito de **Organization** do Clerk para representar o **tenant**, e **Organization Membership** para representar o papel do usuário dentro do tenant (RBAC inicial via Clerk roles, refinado por RBAC próprio da aplicação para papéis operacionais como banhista/tosador/veterinário).

---

## 4. Modelo de Dados — Visão Macro

> Modelagem completa (colunas, constraints, índices) fica a cargo do SPEC de cada microserviço. Abaixo, entidades-chave e relacionamentos de alto nível para orientar o desenho.

### 4.1 Núcleo de Identidade
- `tenant` (id, nome, domínio, configurações, plano, status)
- `user` (id, clerk_user_id, tenant_id, papel, status)
- `role` / `permission` (RBAC customizado além dos papéis Clerk)

### 4.2 Núcleo de Cliente/Pet
- `tutor` (id, tenant_id, dados pessoais, consentimento LGPD)
- `pet` (id, tenant_id, especie_id, raca_id, porte_id, pelagem_id, dados)
- `pet_tutor` (N:N — pet pode ter múltiplos tutores; tutor tem múltiplos pets)
- `especie`, `raca`, `porte`, `pelagem` (tabelas de domínio, globais ou por tenant)
- `pet_foto` (álbum — id, pet_id, url_cloudflare, ordem, capa)

### 4.3 Prontuário
- `atendimento` (id, tenant_id, pet_id, profissional_id, tipo, data, observações)
- `temperamento` (pet_id, classificação, observações)
- `alergia` (id, pet_id, tipo, descrição, severidade, ativo)
- `anexo_prontuario` (id, atendimento_id/pet_id, tipo, url)

### 4.4 Financeiro
- `conta_corrente_lancamento` (id, tenant_id, tutor_id, tipo [débito/crédito], valor, origem, referência, criado_em, imutável)
- Saldo calculado (view/materialized view) a partir dos lançamentos — nunca campo mutável direto.

### 4.5 Agenda / Operação
- `profissional` (id, tenant_id, user_id, tipo [banhista/tosador/veterinário])
- `servico` (id, tenant_id, nome, duração, preço, profissionais_habilitados)
- `agendamento` (id, tenant_id, pet_id, tutor_id, profissional_id, servico_id, data_hora, status, recorrência_id)
- `agendamento_recorrencia` (regra de recorrência — ex. RRULE)
- `taxidog_solicitacao` (id, agendamento_id, tipo [ida/volta/ambos], janela, endereço, status, motorista_id)

### 4.6 Relacionamento / CRM
- `campanha` (id, tenant_id, tipo [inativos/aniversário/lembrete], regras, status)
- `mensagem_enviada` (id, tenant_id, tutor_id, canal [whatsapp/email], template, status_entrega, criado_em)
- `consentimento_comunicacao` (tutor_id, canal, opt_in, atualizado_em)

### 4.7 Auditoria
- `audit_log` (id, tenant_id, usuário, ação, entidade, entidade_id, payload_antes/depois, timestamp) — append-only.

---

## 5. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Linguagem | TypeScript (frontend, backend, mobile) |
| Runtime backend | Node.js |
| Banco de dados | PostgreSQL (com RLS para multi-tenancy) |
| Frontend web | Next.js + React |
| Mobile | Preparado (React Native recomendado por reuso de TS/React) |
| Autenticação | Clerk (Organizations = tenants) |
| Geração de PDF | Gotenberg |
| E-mail transacional | Resend |
| DNS/CDN/Segurança de borda | Cloudflare API |
| Logging | Pino (JSON estruturado) |
| Mensageria/eventos | A definir em SPEC de infraestrutura (ex.: Redis Streams ou RabbitMQ) |
| Containerização | Docker |
| Orquestração | Docker Swarm (atual), preparado para Kubernetes |
| CI/CD | A definir (ex.: GitHub Actions, dado uso de github.com/api.github.com no ambiente) |

---

## 6. Design de API

### 6.1 Padrões gerais
- API REST versionada (`/v1/...`), JSON, seguindo convenções REST (recursos, verbos HTTP, status codes semânticos).
- Cada endpoint de negócio exige contexto de tenant resolvido via token — nunca aceitar `tenant_id` cru do payload para operações de escrita.
- Paginação padrão (cursor ou offset, a definir), filtros e ordenação consistentes entre serviços.
- Erros padronizados (`application/problem+json` ou formato próprio consistente): `code`, `message`, `details`.
- Documentação via OpenAPI/Swagger por serviço, versionada no monorepo (`packages/shared-types` ou pasta `docs/openapi`).

### 6.2 BFFs (Backend-for-Frontend)
- `admin-bff`: agrega dados de múltiplos microserviços para as telas do Admin do tenant, reduzindo chamadas do frontend.
- `portal-bff`: equivalente para o Portal do Tutor (superfície de API reduzida e mais restritiva, já que é acesso do cliente final).

### 6.3 Preparação para Agentes de IA (requisito não-funcional transversal)
- Todo endpoint de negócio deve ter contrato estável, tipado (OpenAPI) e semântica clara o suficiente para ser descrito como *tool* de function calling.
- Operações sensíveis (financeiro, cancelamento, dados pessoais) devem ter escopo de permissão próprio, para que agentes de IA operem com **least privilege** quando essa camada for implementada.

---

## 7. Segurança

### 7.1 Autenticação e Autorização
- **Autenticação:** Clerk (usuários), com suporte a login social e e-mail/senha conforme necessidade do produto.
- **MFA:** obrigatório para papéis administrativos (dono/gerente do tenant) e para o Super Admin da plataforma; recomendado (não obrigatório) para demais papéis operacionais.
- **RBAC:** papéis mínimos — Super Admin (plataforma), Admin (tenant), Atendente, Banhista, Tosador, Veterinário, Motorista, Tutor. Permissões granulares por módulo (ex.: Tutor só acessa seus próprios dados via `portal-bff`).

### 7.2 Criptografia
- Dados sensíveis em repouso: criptografia a nível de coluna para PII crítica (CPF, dados de contato) e/ou criptografia de disco no PostgreSQL, a definir em SPEC de infraestrutura.
- Dados em trânsito: TLS obrigatório em todas as camadas (client↔gateway↔serviços).
- Segredos (chaves de API — Clerk, Resend, Cloudflare, Gotenberg): gerenciados via secret manager/variáveis de ambiente seguras, nunca versionados no repositório.

### 7.3 Rate Limiting e Proteção contra abuso
- Rate limit por IP e por tenant/usuário no API Gateway.
- **Honeypot** em formulários públicos (site do tenant, cadastro, portal) para mitigar bots.
- Proteção Cloudflare (WAF, Bot Management) na borda.

### 7.4 OWASP Top 10 — diretrizes aplicadas
- Validação e sanitização de entrada em todos os serviços (evitar injection).
- Controle de acesso quebrado (broken access control): reforçado por RLS multi-tenant + RBAC em camada de aplicação (defesa em profundidade).
- Configuração seguras por padrão (secure headers, CORS restritivo por domínio de tenant).
- Logging e monitoramento de falhas de autenticação/autorização (ver Observabilidade).
- Gestão de dependências (SCA — Software Composition Analysis) no pipeline de CI.

### 7.5 LGPD
- Base legal e consentimento registrados por titular (tutor) no cadastro.
- Direito de acesso, correção, portabilidade e exclusão (soft delete + anonimização quando há histórico financeiro/legal a preservar).
- Minimização de dados: cada microserviço acessa apenas os dados necessários ao seu domínio.
- Registro de auditoria de acesso a dados sensíveis (prontuário, financeiro).

### 7.6 Segregação entre tenants (resumo consolidado)
- RLS no PostgreSQL (camada de dados).
- Validação de `tenant_id` do token em toda camada de aplicação (defesa em profundidade, não confiar apenas no banco).
- Isolamento de arquivos/mídia por tenant no armazenamento (paths/buckets segregados no Cloudflare).
- Testes automatizados específicos de "cross-tenant leakage" (tentativa de acesso a dado de outro tenant deve sempre falhar) — requisito de QA obrigatório.

---

## 8. Observabilidade

| Pilar | Ferramenta/Prática |
|---|---|
| **Logging** | Pino, logs estruturados em JSON, correlação por `request_id`/`trace_id` e `tenant_id` |
| **Health Checks** | Endpoint `/health` (liveness) e `/ready` (readiness) em cada microserviço |
| **Tracing** | Tracing distribuído entre serviços (padrão OpenTelemetry recomendado), propagação de `trace_id` via headers |
| **Auditoria** | `audit-service` centralizado, consumindo eventos de todos os serviços via mensageria |
| **Dashboard** | Painel operacional (Super Admin): saúde dos serviços, filas, erros por tenant |
| **Alertas** | Alertas configuráveis para falhas de integração (WhatsApp, Resend, Gotenberg, Cloudflare), filas travadas, uso anômalo |

---

## 9. Infraestrutura e Deploy

### 9.1 Containerização
- Todos os serviços (backend, frontend, BFFs) empacotados em Docker, com imagens versionadas.
- `docker-compose` para ambiente de desenvolvimento local (todos os microserviços + PostgreSQL + broker de mensagens).

### 9.2 Orquestração
- **Produção inicial:** Docker Swarm — stacks declarativas, réplicas por serviço, secrets gerenciados pelo Swarm.
- **Preparação para Kubernetes:** arquitetura desenhada de forma "container-native" (12-factor app), sem acoplamento a recursos exclusivos do Swarm, permitindo migração futura para K8s (Helm charts podem ser derivados das stacks Swarm).

### 9.3 CI/CD
- Pipeline por serviço/app do monorepo (build, testes, lint, scan de dependências, build de imagem, deploy).
- Estratégia de deploy: rolling update, com health checks bloqueando promoção em caso de falha.
- Ambientes: development → staging → production.

### 9.4 Backup e Recuperação
- Backup automatizado do PostgreSQL (full + incremental/WAL), com retenção definida por política (a detalhar em SPEC de infraestrutura).
- Testes periódicos de restauração (restore drill).
- Backup de mídia (Cloudflare) coberto pela própria durabilidade do provedor, com política de retenção definida por tenant/plano.

### 9.5 Escalabilidade horizontal
- Serviços stateless escaláveis horizontalmente (réplicas atrás de load balancer/gateway).
- PostgreSQL: read replicas para leitura pesada (relatórios, dashboards) conforme crescimento.
- Filas/mensageria dimensionadas para absorver picos (ex.: envio de campanha em massa).

---

## 10. Estratégia de Testes (diretriz geral)

- **Testes unitários** por serviço (regras de negócio isoladas).
- **Testes de integração** por serviço (contrato com banco de dados e integrações externas mockadas).
- **Testes de contrato de API** (garantia de compatibilidade entre BFFs e microserviços).
- **Testes de isolamento multi-tenant** (obrigatórios): garantir que nenhuma operação vaza dados entre tenants.
- **Testes end-to-end** dos fluxos críticos: cadastro → agendamento → check-in/out → cobrança → lembrete WhatsApp.

---

## 11. Convenções Técnicas (a formalizar em ADRs)

- Nomenclatura de serviços: `kebab-case` + sufixo `-service`/`-bff`.
- Versionamento semântico de pacotes compartilhados (`packages/*`).
- Migrations de banco versionadas por serviço (ferramenta a definir, ex. Prisma Migrate/Drizzle).
- Padrão de eventos de domínio: `dominio.acao` (ex.: `agendamento.criado`, `pagamento.registrado`).
- Todo novo microserviço deve nascer com: health check, logging Pino, RLS habilitado (se aplicável), documentação OpenAPI.

---

## 12. Considerações para a Futura Camada de Agentes de IA

Embora fora do escopo de construção imediata, as seguintes decisões técnicas **devem ser tomadas agora** para não gerar retrabalho:

1. **APIs como contrato de tools:** todo endpoint de negócio relevante para atendimento (consultar agenda, criar agendamento, consultar saldo, registrar alergia) deve ser desenhado desde já como uma operação atômica, bem documentada e idempotente onde aplicável.
2. **Eventos de domínio ricos:** o barramento de eventos (usado hoje por CRM/automação) é a mesma base que futuramente alimentará os agentes com contexto em tempo real.
3. **Auditoria e permissão granular:** essencial para, no futuro, restringir o que um agente de IA pode executar autonomamente vs. o que requer confirmação humana.
4. **Separação BFF vs. domínio:** ao manter regra de negócio nos microserviços (não nos BFFs), um futuro `agent-orchestrator-service` pode reutilizar exatamente as mesmas regras/validações que o Admin e o Portal usam hoje.

---

## 13. Documentos Derivados (próximos passos)

A partir deste SPEC, cada microserviço listado na seção 2 deve receber um **SPEC de módulo**, contendo:
- Modelo de dados completo (DDL/ERD).
- Contrato OpenAPI detalhado.
- Regras de negócio e máquina de estados (quando aplicável, ex.: status de agendamento, status de Taxi Dog).
- Requisitos específicos de segurança e observabilidade do serviço.

Este documento e o PRD.md formam a referência mestre para o desdobramento de todos os módulos do PetShop AI.
