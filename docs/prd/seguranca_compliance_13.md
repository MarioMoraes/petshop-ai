# PRD Detalhado — Segurança e Compliance

**Módulo:** MOD-SEC
**Arquivo:** 13/15
**Prioridade:** P0
**Fase de Implementação:** Fase 7 — Segurança e Compliance avançada
**Serviço Backend:** nenhum serviço novo. `backend/api-gateway/src/modules/security` (módulo do backend único) e duas guardas no host (`src/auth/session.ts`, `src/app.ts`)
**Tabelas Principais:** `audit_logs`, `security_events`, `memberships` (alteradas). Nenhuma tabela nova
**Data:** 2026-09-09
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** Um petshop guarda o telefone, o CPF, o endereço e a rotina de
centenas de famílias, e a pessoa que opera o balcão troca. O produto já isola tenants,
cifra PII e registra o que cada um faz — o que ele **não** faz é deixar alguém ver esse
registro, exigir segundo fator de quem tem poder de apagar tudo, ou parar de acumular
rastro de rede para sempre. Este módulo fecha essas três lacunas.

**Este é o módulo mais curto do produto, e a razão é boa.** Segurança não foi tratada
como frente separada: cada módulo pagou a sua parte no caminho. O inventário do que
**já está no ar** e que este PRD **não** reespecifica:

| O que | Onde | Desde |
|---|---|---|
| Isolamento multi-tenant por RLS, com `FORCE ROW LEVEL SECURITY` | `20260822130000_rls_policies` | MOD-IDENT-07 |
| Matriz de papéis e ajuste por tenant (`tenant_role_overrides`) | `packages/shared-types/src/permissions.ts` | MOD-IDENT-04 |
| Cifra AES-256-GCM com DEK por tenant (envelope) | `packages/db`, `data_keys` | MOD-IDENT-01 |
| Trilha de auditoria append-only, redigida por chave | `packages/service-kit/src/audit.ts` | MOD-IDENT-09 |
| `security_events` com dois emissores | `packages/service-kit/src/security-events.ts` | MOD-IDENT-04 |
| Rate limit por tenant+usuário e por IP | `src/app.ts` | Gateway |
| Rate limit próprio do formulário público e do vínculo do Portal | `modules/site/rate-limit.ts`, `portal-bff` | MOD-SITE-08, MOD-PORTAL-02 |
| Honeypot nos dois formulários anônimos que existem | `lead-form.tsx`, `link-form.tsx` | MOD-SITE-08, MOD-PORTAL-01 |
| Consentimento append-only por canal e finalidade | `modules/consents` | MOD-TUTOR-04 |
| Termos versionados e imutáveis depois de publicados | `modules/terms` | MOD-DOC-06 |
| Anonimização do titular, com propagação por evento | `modules/tutors/service.ts` | MOD-TUTOR-08 |
| Portabilidade (`GET /v1/tutors/:id/export`) | `modules/tutors/overview.ts` | MOD-TUTOR-07 |
| Fila de pedidos de exclusão, com prazo do art. 19 congelado | `data_deletion_requests` + tela | MOD-PORTAL-09 |
| HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy` | `infra/Caddyfile` | Implantação |
| CORS por lista de origens, nunca `*` com credenciais | `src/app.ts` | Gateway |

**As três descobertas que dão substância ao módulo.**

A primeira: **a trilha de auditoria é cega.** Mais de sessenta arquivos escrevem em
`audit_logs`, incluindo o guarda `requirePermission`, que grava toda negação com
`outcome = DENIED`. A permissão `audit:read` existe na matriz desde o MOD-IDENT-04. E
não há **uma única rota** que leia a tabela, em nenhum processo, nem tela que a mostre.
O dono do petshop que quer saber quem apagou a ficha de um cliente não tem para onde
olhar; a plataforma, tampouco. Uma trilha que ninguém lê não dissuade ninguém.

A segunda: **metade do enum de evento de segurança é código morto.**
`SecurityEventType` declara cinco tipos. Só dois chegam à tabela: `PERMISSION_DENIED`,
pelo guarda, e `LOGIN_FAILED`, no vínculo do Portal. `CROSS_TENANT_ATTEMPT` — que o
AC-02 de MOD-IDENT-07 **exige** — nunca é emitido; `WEBHOOK_SIGNATURE_INVALID` e
`TENANT_CONTEXT_MISSING`, também não. Os três casos acontecem no sistema e o único
registro que deixam é uma linha de log, que ninguém consulta por tenant.

A terceira: **`mfa_enabled` é espelho, nunca regra.** O campo vem do Clerk, é gravado
em `users`, aparece na lista de equipe e não é lido por decisão nenhuma. O SPEC §7.2 diz
"obrigatório para papéis administrativos"; hoje é opcional para todo mundo, e a conta
que pode anonimizar cliente, mexer no financeiro e convidar gente se protege com uma
senha.

**Escopo da v1.** As nove sub-features do §2. Ficam **fora**, por decisão registrada em
2026-09-09:

- **O painel de plataforma e o Super Admin** — o papel `SUPER_ADMIN` existe no enum sem
  caminho de atribuição, e `support_access_grant` (RN-10 de MOD-IDENT) não existe no
  schema. É MOD-ADMIN (arquivo 14), e este módulo não o antecipa.
- **A observabilidade do SPEC §8** — `recordMetric` só escreve no log; não há Prometheus,
  OpenTelemetry nem Sentry. Também MOD-ADMIN.
- **SCA no pipeline** (SPEC §7.4) — é configuração de CI, não código do produto.
- **Bot management da Cloudflare** (SPEC §7.3) — é painel de borda, não repositório.
- **Cifra de disco no PostgreSQL** — é decisão de infraestrutura da VPS.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-SEC-01 | O claim de MFA no token | O JWT do Clerk passa a publicar o segundo fator; o gateway o lê | Must Have |
| MOD-SEC-02 | MFA obrigatório para o administrador | `TENANT_ADMIN` sem segundo fator perde a escrita | Must Have |
| MOD-SEC-03 | A carência de sete dias | Ninguém para de trabalhar por causa de um deploy | Must Have |
| MOD-SEC-04 | Leitura da trilha de auditoria | `GET /v1/audit-logs`, com filtro e cursor | Must Have |
| MOD-SEC-05 | Leitura dos eventos de segurança | `GET /v1/security-events`, mesma forma | Must Have |
| MOD-SEC-06 | A aba Segurança | Onde o administrador lê as duas coisas | Must Have |
| MOD-SEC-07 | Os emissores que faltam | Os três tipos declarados e nunca gravados | Must Have |
| MOD-SEC-08 | Retenção de 24 meses | A trilha deixa de crescer para sempre | Must Have |
| MOD-SEC-09 | Rate limit do webhook e CSP na borda | As duas frestas de superfície que sobraram | Should Have |

---

## 3. Critérios de Aceite

### [MOD-SEC-01] — O Claim de MFA no Token

> **Decisão (2026-09-09): a fonte é o token, não a tabela.** `users.mfa_enabled` é
> espelho, escrito quando o `ensureLocalUser` sincroniza com o Clerk — pode estar velho
> por horas. Uma decisão de autorização tomada sobre espelho velho barra quem acabou de
> ligar o segundo fator, e é o pior defeito possível: a pessoa faz o que o produto pediu
> e continua bloqueada. O claim vem no mesmo token que já traz `org_id` e `permVersion`,
> e é tão fresco quanto a sessão.

**AC-01 (Happy Path — o claim chega e é lido)**
- **Dado** um JWT template `petshop` que publica `mfa` a partir de `user.two_factor_enabled`
- **Quando** o gateway verifica o token
- **Então** `SessionClaims.mfaEnabled` é `true` ou `false`, e o estado resolvido sai em
  `ResolveSessionResult.mfa`, que o hook do app deixa em `request.mfa`

> **Fica fora do `ServiceAuthContext`, de propósito.** Aquele é o contrato assinado que
> atravessa para os serviços ainda não migrados, e o segundo fator é condição **da
> porta**: verificada em `resolveSession`, antes de qualquer roteamento. Um serviço atrás
> dela não tem decisão a tomar com esse dado, e acrescentá-lo ao payload canônico mudaria
> a assinatura HMAC sem que ninguém a lesse do outro lado.

**AC-02 (Template não configurado — a ausência não é um "não")**
- **Dado** um token cujo template ainda não declara o claim
- **Quando** o gateway o verifica
- **Então** `SessionClaims.mfaEnabled` é `null`, **a exigência não é aplicada**, e sai um
  `logger.warn` nomeando o template e o documento (`docs/setup-clerk.md §3`)

> **Por que `null` libera em vez de barrar.** É a mesma escolha que
> `warnIfOrgClaimMissing` já faz para `org_id`: um template mal configurado é erro de
> operação, não tentativa de burlar. Tratar "não sei" como "não tem" transformaria um
> deploy com template desatualizado em indisponibilidade total do Admin, sem nada no
> corpo da resposta que explicasse por quê. O aviso no log é o que faz o erro aparecer.

**AC-03 (Espelho — a tabela continua sendo atualizada)**
- **Dado** o `ensureLocalUser` sincronizando um usuário
- **Quando** o Clerk informa `twoFactorEnabled`
- **Então** `users.mfa_enabled` é gravado como hoje — o espelho serve à **lista de
  equipe** (quem ainda não ligou), nunca à decisão de autorização

---

### [MOD-SEC-02] — MFA Obrigatório para o Administrador

> **Decisão (2026-09-09): é política da plataforma, e só do `TENANT_ADMIN`.** Não é
> configurável por tenant — uma proteção que o cliente pode desligar fica desligada. E é
> só o administrador porque é o único papel que apaga cliente, movimenta a conta corrente
> e convida gente; exigir de toda a recepção multiplicaria o suporte sem mudar o que
> alguém consegue fazer com uma conta tomada.

**AC-01 (Happy Path — administrador com MFA opera normalmente)**
- **Dado** um `TENANT_ADMIN` cujo token traz `mfa = true`
- **Quando** faz qualquer requisição
- **Então** nada muda

**AC-02 (Escrita bloqueada)**
- **Dado** um `TENANT_ADMIN` com `mfa = false` e carência vencida
- **Quando** faz `POST`, `PATCH`, `PUT` ou `DELETE` em qualquer rota
- **Então** **423** `ERR_SEC_001`, com `detail` "Ative a verificação em duas etapas para
  voltar a operar", e o corpo carrega `mfaEnrollmentRequired: true`

**AC-03 (Leitura permanece)**
- **Dado** o mesmo administrador
- **Quando** faz `GET` ou `HEAD`
- **Então** **200** — consulta, exportação LGPD e a própria tela de configurações
  continuam alcançáveis

> **Espelha o RN-04 do tenant suspenso, e pela mesma razão.** O gate de suspensão libera
> leitura para que o titular consiga exercer os direitos dele mesmo com o estabelecimento
> parado. Aqui vale o inverso do mesmo argumento: um administrador trancado fora da
> leitura não consegue nem chegar à tela que explica o que fazer.

**AC-04 (`/v1/me` nunca é barrado)**
- **Dado** o mesmo administrador
- **Quando** chama `GET /v1/me`
- **Então** **200**, com `mfaRequired: true` e `mfaGraceEndsAt` no corpo — é por este
  campo que o frontend decide mostrar a faixa de aviso ou a tela de bloqueio

**AC-05 (Outros papéis não são afetados)**
- **Dado** um `RECEPTIONIST`, `GROOMER`, `BATHER`, `VET` ou `DRIVER` sem MFA
- **Quando** escreve
- **Então** **200** — a exigência não vale para eles na v1

**AC-06 (A recusa vira evento de segurança)**
- **Dado** uma escrita barrada por falta de MFA
- **Quando** o gate recusa
- **Então** grava-se um `security_events` de tipo `MFA_REQUIRED`, com `tenant_id`,
  `actor_user_id`, IP e user-agent

> **Não gera `audit_logs`.** A trilha de auditoria registra o que **mudou**; aqui nada
> mudou. Uma recusa repetida a cada clique de um admin sem MFA encheria a trilha de
> ruído e empurraria o expurgo para cima. É `security_events`, que é onde padrão de
> tentativa mora.

---

### [MOD-SEC-03] — A Carência de Sete Dias

> **Decisão (2026-09-09): sete dias de aviso, depois bloqueio de escrita.** A alternativa
> — valer a partir do deploy — para o balcão de todos os clientes ao mesmo tempo, num
> horário que nós escolhemos e eles não. Sete dias é uma semana de trabalho: quem abre o
> Admin em qualquer dia útil vê o aviso antes de ser barrado.

**AC-01 (Backfill — quem já é admin ganha o prazo)**
- **Dado** o deploy da migration
- **Quando** ela roda
- **Então** todo `memberships` com `role_key = 'TENANT_ADMIN'` e `status = 'ACTIVE'`
  recebe `mfa_grace_until = now() + 7 dias`

**AC-02 (Admin novo — o prazo nasce com o papel)**
- **Dado** um membership criado como `TENANT_ADMIN`, ou promovido a ele por
  `PATCH /v1/memberships/:id`
- **Quando** a gravação acontece
- **Então** `mfa_grace_until = now() + MFA_GRACE_DAYS`, na **mesma transação**

> **Por que uma coluna e não uma data calculada.** A alternativa era derivar o prazo de
> uma data de corte no ambiente mais `joined_at`. Ela erra no caso que mais importa: uma
> recepcionista promovida a administradora em março tem `joined_at` de janeiro, e seria
> barrada no mesmo instante em que ganhou o papel. O prazo é do **papel**, não da pessoa,
> e por isso é escrito quando o papel é atribuído.

**AC-03 (Dentro da carência — avisa e deixa passar)**
- **Dado** um `TENANT_ADMIN` sem MFA e `mfa_grace_until` no futuro
- **Quando** escreve
- **Então** **200**, e `GET /v1/me` devolve `mfaRequired: true` com `mfaGraceEndsAt`
  preenchido; o Admin mostra uma faixa em toda tela

**AC-04 (Rebaixado — o prazo some junto)**
- **Dado** um `TENANT_ADMIN` que vira `RECEPTIONIST`
- **Quando** a troca de papel é gravada
- **Então** `mfa_grace_until` volta a `NULL` — e se um dia voltar a ser administrador,
  ganha carência nova

**AC-05 (Ligou o MFA — a carência deixa de importar)**
- **Dado** um administrador que ativou o segundo fator no Clerk
- **Quando** o token seguinte chega com `mfa = true`
- **Então** passa, independentemente de `mfa_grace_until`. **A coluna não é limpa**: ela
  registra o prazo que foi dado, e desligar o MFA depois não devolve prazo nenhum

---

### [MOD-SEC-04] — Leitura da Trilha de Auditoria

**AC-01 (Happy Path)**
- **Dado** um usuário com `audit:read`
- **Quando** chama `GET /v1/audit-logs`
- **Então** **200** com as linhas do **próprio tenant**, mais recentes primeiro, no
  máximo 50 por página, e `nextCursor` quando houver mais

**AC-02 (Filtros)**
- **Dado** a mesma rota
- **Quando** recebe `from`, `to`, `actorUserId`, `entity`, `entityId` ou `outcome`
- **Então** aplica todos em conjunção; `from`/`to` são ISO-8601 e a janela máxima é de
  **92 dias** por consulta

> **O teto de janela não é performance, é forma de uso.** Sem ele, a primeira coisa que
> alguém faz é pedir dois anos de trilha e receber uma página de cinquenta linhas de
> 2024. Noventa e dois dias cobrem um trimestre, que é o recorte de quem investiga.

**AC-03 (Sem permissão)**
- **Dado** um `RECEPTIONIST`, que não tem `audit:read` na matriz
- **Quando** chama a rota
- **Então** **403** `ERR_SEC_003`, e a negação vira `audit_logs` com `outcome = DENIED`
  mais um `security_events` de `PERMISSION_DENIED`, como toda negação

**AC-04 (Cross-tenant)**
- **Dado** um administrador do tenant A
- **Quando** filtra por um `entityId` que só existe no tenant B
- **Então** **200** com lista vazia — o RLS não devolve a linha, e a resposta não revela
  que ela existe em outro lugar

**AC-05 (Nada é desredigido)**
- **Dado** uma linha cujo `before`/`after` teve campos substituídos por `[redacted]` na
  escrita
- **Quando** é lida
- **Então** vem como está. **Não há caminho de desredação** — o valor não foi cifrado,
  foi descartado, e não existe mais em lugar nenhum

**AC-06 (O ator vem resolvido)**
- **Dado** uma linha com `actor_user_id`
- **Quando** é lida
- **Então** a resposta traz `actorName` e `actorEmailMasked`, resolvidos em lote pela
  rota; linha de job traz `actorName: null` e `actorKind: 'SYSTEM'`

> **O e-mail vai mascarado, e o motivo é o próprio módulo.** Quem lê a trilha está
> auditando colegas. Precisa distinguir duas pessoas de mesmo nome, não obter a lista de
> e-mails da equipe numa consulta que não passa pelo `team:read`.

---

### [MOD-SEC-05] — Leitura dos Eventos de Segurança

**AC-01 (Happy Path)**
- **Dado** um usuário com `audit:read`
- **Quando** chama `GET /v1/security-events`
- **Então** **200**, mesma paginação e mesma janela máxima do MOD-SEC-04, filtrável por
  `type` e `actorUserId`

**AC-02 (Resumo por tipo)**
- **Dado** a mesma rota com `?summary=true`
- **Quando** responde
- **Então** devolve a contagem por tipo no período, sem as linhas — é o que a tela mostra
  antes de alguém pedir o detalhe

**AC-03 (As linhas de plataforma não aparecem)**
- **Dado** eventos com `tenant_id` nulo (webhook sem assinatura válida, por exemplo, que
  chega sem tenant nenhum)
- **Quando** um administrador de tenant lê
- **Então** eles **não** vêm — são invisíveis por RLS, e é a plataforma quem os lê, por
  `app_maintenance`, quando o MOD-ADMIN existir

---

### [MOD-SEC-06] — A Aba Segurança

> **Aba própria, e não a de Privacidade.** A aba `Privacidade` que existe hoje é a fila
> de pedidos de exclusão, gateada por `tutor:delete`, e serve a quem atende o titular. A
> trilha é gateada por `audit:read` e serve a quem administra a equipe. Mesmo diretório,
> outra aba, outro leitor.

**AC-01 (A aba só aparece para quem pode ler)**
- **Dado** a tela de Configurações
- **Quando** o usuário não tem `audit:read`
- **Então** a aba não é montada — e a rota do backend recusa de qualquer forma, porque
  esconder o botão é conveniência e não controle

**AC-02 (Duas seções)**
- **Dado** a aba aberta
- **Então** mostra **Trilha de auditoria** e **Eventos de segurança**, cada uma com
  `<SectionHead>` e um tom de ícone só, conforme `docs/design-formularios.md`

**AC-03 (Filtros em cartão macio, lista em cartão branco)**
- **Dado** as duas seções
- **Então** os filtros ficam em `<Card tone="soft">` com `.field` e `<Segmented>`; a lista
  é `RowStack` em cartão branco. Nenhum controle nativo sem estilo

**AC-04 (A linha é legível por quem não escreveu o código)**
- **Dado** uma linha `tutor.anonymized` sobre a entidade `tutor`
- **Então** a tela mostra "Fulana anonimizou o cadastro de um cliente", com data, hora e
  o desfecho — não o `action` cru

> **O catálogo de tradução mora no frontend, e é intencionalmente incompleto.** Uma ação
> sem tradução aparece com o código, e não some da lista: uma trilha que esconde o que
> não sabe explicar é pior que uma trilha feia.

**AC-05 (Paginação por cursor, sem contagem total)**
- **Dado** mais de 50 linhas
- **Então** um botão "Carregar mais". **Não há total** — contar linhas de uma tabela de
  dois anos a cada abertura de tela é uma varredura por curiosidade

---

### [MOD-SEC-07] — Os Emissores que Faltam

**AC-01 (`CROSS_TENANT_ATTEMPT`)**
- **Dado** uma requisição que chega de fora carregando `x-petshop-tenant-id` de outro
  estabelecimento
- **Quando** o gateway resolve a sessão
- **Então** o header é descartado como sempre, a requisição segue com o tenant que o
  gateway resolveu, e grava-se `security_events` de `CROSS_TENANT_ATTEMPT` com `target_id`
  igual ao tenant reivindicado

> **Este é o único ponto do sistema em que a tentativa é observável, e é por isso que o
> emissor nunca existiu.** O AC-02 de MOD-IDENT-07 o pede desde sempre, e se procurava
> por ele no lugar errado: nenhum guarda de escopo recusa acesso cross-tenant, porque **o
> cliente não tem como nomear um tenant**. O contexto sai do token, e o que o RLS esconde
> volta como 404 sem que ninguém saiba se a linha existe noutro lugar.
>
> O que resta observável é a tentativa de **se declarar** de outro estabelecimento. O
> `proxy.ts` já descartava esses headers, e é isso que a torna inofensiva; descartar em
> silêncio é o que a tornava invisível — alguém podia varrer a instalação a semana inteira
> sem deixar rastro. Uma requisição legítima nunca os carrega pela porta de fora: quem os
> envia com assinatura válida entra pela porta interna, que retorna antes.

**AC-02 (`WEBHOOK_SIGNATURE_INVALID`)**
- **Dado** uma requisição com assinatura de serviço presente e inválida, ou um webhook de
  provedor cuja assinatura não confere
- **Quando** `resolveInternalRequest` ou a rota do webhook recusa
- **Então** grava-se o evento com `tenant_id` nulo quando não há tenant a atribuir

**AC-03 (`TENANT_CONTEXT_MISSING`)**
- **Dado** uma consulta que alcança tabela com RLS sem `current_tenant_id()` definido
- **Quando** o handler de erro do processo reconhece o `TenantContextMissingError`
- **Então** grava-se o evento com `tenant_id` nulo — por definição deste erro, não havia
  contexto — e o erro segue para a tradução de sempre, que responde 404

> **É o mais importante dos três**: significa que uma consulta escapou do `withTenant`, e
> o RLS foi a última linha de defesa em vez da segunda.
>
> O emissor é um ramo de observação em `shared/errors.ts`, que devolve `null`. O
> `packages/db` não pode emiti-lo sozinho — ele não conhece o `service-kit` —, e traduzir
> o erro no ramo duplicaria a decisão de responder 404, que é do kit e precisa continuar
> sendo dele.
>
> **Este emissor pagou o próprio custo no dia em que foi ligado**: a primeira coisa que
> ele apanhou foi um defeito desta mesma fatia, uma leitura de `memberships` fora do
> `withTenant` dentro do gate de MFA, que fazia o administrador sem segundo fator receber
> 404 em toda rota. Ver o comentário em `resolveMfaState`.

**AC-04 (A gravação nunca derruba a requisição)**
- **Dado** qualquer um dos três casos com o banco indisponível
- **Quando** a gravação do evento falha
- **Então** sai um `logger.error` e a recusa original é respondida como sempre

---

### [MOD-SEC-08] — Retenção de 24 Meses

> **Decisão (2026-09-09): vinte e quatro meses, e o expurgo apaga a linha.** É o mesmo
> prazo que `messaging.retention` já usa. A alternativa — manter a linha e limpar só IP e
> user-agent — deixa a tabela crescer para sempre em troca de um fato ("alguém alterou
> algo em 2024") que ninguém vai consultar.

**AC-01 (Job diário)**
- **Dado** o job `security.retention`
- **Quando** roda (03h40, depois dos outros expurgos)
- **Então** apaga de `audit_logs` e `security_events` as linhas com
  `created_at < now() - AUDIT_RETENTION_MONTHS`

**AC-02 (Em lotes, e não numa transação só)**
- **Dado** um primeiro expurgo sobre dois anos acumulados
- **Quando** o job roda
- **Então** apaga em lotes de 5.000 linhas, com teto de tempo por execução; o que sobrar
  fica para a passada seguinte

> **Um `DELETE` único sobre a tabela inteira segura o lock e infla o WAL** durante o
> horário em que o backup roda. O job é diário e idempotente: não precisa terminar hoje.

**AC-03 (A exceção ao append-only é nomeada)**
- **Dado** que `audit_logs` tem `REVOKE UPDATE, DELETE` e um trigger que barra os dois
  para todos, inclusive `app_maintenance`
- **Quando** a migration deste módulo roda
- **Então** o trigger passa a **permitir `DELETE` quando `current_user = 'app_maintenance'`**
  e continua barrando `UPDATE` para todos, e o `GRANT DELETE ON audit_logs TO app_maintenance`
  é dado explicitamente

**AC-04 (A role da aplicação continua sem poder apagar)**
- **Dado** uma tentativa de `DELETE` em `audit_logs` como `app_user`
- **Então** o banco recusa — pelo `REVOKE` e pelo trigger, nesta ordem

**AC-05 (`security_events` já estava aberto)**
- **Dado** que `security_events` nunca teve `REVOKE` nem trigger
- **Então** o expurgo dela não precisa de migration; a migration **acrescenta** o
  `REVOKE UPDATE` que faltava, porque evento de segurança também não se corrige

---

### [MOD-SEC-09] — Rate Limit do Webhook e CSP na Borda

**AC-01 (`/internal/` sai do `allowList`)**
- **Dado** o prefixo `/internal/`, hoje inteiramente fora do balde global
- **Quando** este módulo entra
- **Então** ele passa a ter balde próprio, por IP de origem, com teto separado
  (`WEBHOOK_RATE_LIMIT_MAX`) — mais folgado que o do Admin, porque provedor legítimo
  entrega em rajada

**AC-02 (`/public/` continua fora)**
- **Dado** o prefixo `/public/`
- **Então** nada muda: em produção quem o chama é o servidor do Next, por um IP só, e um
  balde por IP juntaria o site de todos os tenants num teto comum. Quem o defende é o
  módulo, com o recorte por tenant **e** por IP do visitante

**AC-03 (Estouro no webhook não vira 429 visível)**
- **Dado** um webhook além do teto
- **Então** **429**, e um `security_events` de `WEBHOOK_SIGNATURE_INVALID` **não** é
  gravado — o estouro não é assinatura inválida, e confundir os dois estragaria a
  contagem que o painel mostra

**AC-04 (CSP em `Report-Only` primeiro)**
- **Dado** o `Caddyfile`
- **Quando** este módulo entra
- **Então** acrescenta `Content-Security-Policy-Report-Only`, montada contra o que as
  três raízes do Next carregam de fato — Clerk, fontes do Google e o R2

> **Report-Only, e não a política valendo.** O Admin carrega o script do Clerk, o Portal
> carrega o mesmo, e o site do tenant carrega imagem de bucket. Uma CSP restritiva errada
> não degrada: apaga a tela, e só no navegador do cliente. A promoção a
> `Content-Security-Policy` é uma linha, depois de uma semana sem violação no relatório —
> e fica registrada como a questão 3 do §11.

---

## 4. Modelo de Dados

### Tabelas Alteradas

**`memberships`** — uma coluna:

| Campo | Tipo | Nulo | Nota |
|---|---|---|---|
| `mfa_grace_until` | `TIMESTAMPTZ(6)` | sim | Fim da carência de MFA. Não-nulo só em membership `TENANT_ADMIN` |

**`audit_logs`** — nenhuma coluna. Muda o trigger `audit_logs_append_only`, que passa a
deixar `DELETE` passar para `app_maintenance`, e entra `GRANT DELETE ... TO app_maintenance`.

**`security_events`** — nenhuma coluna. Entra `REVOKE UPDATE ... FROM app_user, app_maintenance`
(o `DELETE` fica, porque é o que o expurgo usa).

### Enum Alterado

`SecurityEventType` ganha `MFA_REQUIRED`. Os cinco valores existentes ficam.

### Índices Necessários

| Índice | Tabela | Para quê |
|---|---|---|
| `(tenant_id, created_at DESC)` | `audit_logs` | **já existe** — é o da listagem |
| `(tenant_id, actor_user_id, created_at DESC)` | `audit_logs` | filtro por ator |
| `(created_at)` | `audit_logs` | o expurgo, que varre por data sem tenant |
| `(tenant_id, created_at DESC)` e `(type, created_at DESC)` | `security_events` | **já existem** |
| `(created_at)` | `security_events` | o expurgo |

> **O índice do expurgo é por `created_at` puro, sem `tenant_id`.** O job é cross-tenant
> por definição e roda como `app_maintenance`; um índice que começa por tenant não serve
> a uma varredura que ignora tenant.

### Campos com Criptografia AES-256-GCM

Nenhum campo novo. `audit_logs` e `security_events` **não cifram nada**: o que seria
sensível já foi descartado por `sanitize()` na escrita, e `ip_address`/`user_agent` são
prova de origem que precisa ser legível para servir de prova. O que os protege é o RLS,
a permissão `audit:read` e a retenção de 24 meses.

---

## 5. Contratos de API

### Endpoints

| Método | Rota | Permissão | Descrição |
|---|---|---|---|
| GET | `/v1/audit-logs` | `audit:read` | Trilha do tenant, paginada por cursor |
| GET | `/v1/security-events` | `audit:read` | Eventos do tenant; `?summary=true` devolve contagem por tipo |

Os dois vivem em `backend/api-gateway/src/modules/security/routes.ts`, num escopo
autenticado próprio, registrado em `src/gateway/routes.ts`.

`GET /v1/me` ganha um objeto `mfa` no corpo: `{ required, enabled, graceEndsAt }`. É
por ele que a tela decide entre a faixa de aviso e o bloqueio, e é a **mesma conta** que
o backend fez para deixar ou não a escrita passar — não uma segunda leitura do estado.

### Schema Zod — `packages/shared-types/src/security.ts`

```ts
export const AuditLogQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  actorUserId: z.uuid().optional(),
  entity: z.string().max(60).optional(),
  entityId: z.string().max(60).optional(),
  outcome: z.enum(['ALLOWED', 'DENIED']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
})

export const SecurityEventQuerySchema = AuditLogQuerySchema.omit({
  entity: true,
  entityId: true,
  outcome: true,
}).extend({
  type: z.enum(SECURITY_EVENT_TYPES).optional(),
  summary: z.coerce.boolean().default(false),
})
```

> **`.omit().extend()`, e nunca `.partial()`.** A armadilha já custou um defeito neste
> repositório: `.partial()` não remove `default()`, e um schema derivado por ele grava o
> padrão por cima do que o usuário não mandou. Aqui o `limit` tem default de propósito e
> os dois schemas o compartilham — mas a forma continua sendo a de dois schemas
> explícitos.

### Códigos de Erro

| Código | Status | Quando |
|---|---|---|
| `ERR_SEC_001` | 423 | Escrita barrada por falta de MFA (MOD-SEC-02) |
| `ERR_SEC_002` | 422 | Parâmetro de consulta inválido, ou janela maior que 92 dias |
| `ERR_SEC_003` | 403 | Sem `audit:read` |

`ERR_SEC_001` é lançado de `src/auth/session.ts`, que é host e não módulo. O catálogo
mora em `modules/security/errors.ts` e o host o importa — como já faz com
`translateMultipartLimit` do MOD-PET.

---

## 6. Máquinas de Estado

### Membership `TENANT_ADMIN` — exigência de MFA

```
                    ┌──────────────────────────────────────┐
                    │                                      │
  (vira admin)      ▼                                      │
 ──────────►  EM CARÊNCIA  ──(prazo vence, mfa=false)──►  BLOQUEADO
               (avisa,                                   (só leitura)
                escreve)                                      │
                    │                                         │
                    └──(mfa=true)──►  CONFORME  ◄─────────────┘
                                    (escreve)
                                         │
                                  (deixa de ser admin)
                                         ▼
                                    NÃO SE APLICA
```

| De | Para | Gatilho | Efeito colateral |
|---|---|---|---|
| — | EM CARÊNCIA | membership vira `TENANT_ADMIN` | grava `mfa_grace_until` |
| EM CARÊNCIA | BLOQUEADO | `now() > mfa_grace_until` e `mfa = false` | `security_events` a cada escrita recusada |
| EM CARÊNCIA / BLOQUEADO | CONFORME | token chega com `mfa = true` | nenhum |
| CONFORME | BLOQUEADO | admin desliga o MFA no Clerk | sem carência nova |
| qualquer | NÃO SE APLICA | troca de papel | `mfa_grace_until` volta a `NULL` |

> **Desligar o MFA não devolve carência.** Quem já ligou sabe onde fica. O caminho de
> volta é ligar de novo, não esperar sete dias.

---

## 7. Regras de Negócio & Edge Cases

| # | Regra |
|---|---|
| RN-01 | A exigência de MFA é da plataforma e vale só para `TENANT_ADMIN` ativo. Não há configuração por tenant |
| RN-02 | A decisão sai do **claim do token**; `users.mfa_enabled` é espelho e serve à tela, nunca à autorização |
| RN-03 | Claim ausente é "não sei" e **libera**, com aviso no log. Só `mfa = false` explícito barra |
| RN-04 | O gate roda em `resolveSession`, antes do roteamento — vale para rota de módulo e para rota ainda encaminhada |
| RN-05 | Métodos de leitura nunca são barrados por MFA, e `/v1/me` nunca é barrado por nada |
| RN-06 | `audit:read` é a permissão das duas leituras. Na matriz, só `TENANT_ADMIN` a tem |
| RN-07 | Janela de consulta máxima de 92 dias; sem `from`/`to`, os últimos 30 dias |
| RN-08 | Retenção de 24 meses para as duas tabelas, contada de `created_at` |
| RN-09 | O expurgo é a **única** exceção ao append-only de `audit_logs`, roda como `app_maintenance` e só apaga |
| RN-10 | Gravar evento de segurança é best-effort: falha vira log e nunca altera a resposta |
| RN-11 | Linha de `audit_logs`/`security_events` com `tenant_id` nulo é da plataforma e invisível a todo tenant |

**Edge cases:**

| Caso | Comportamento |
|---|---|
| Admin sem MFA na hora de aceitar convite | O aceite é `POST` mas roda **antes** de haver membership — não há papel a exigir, e passa. A carência começa na criação do membership (AC-02 de MOD-SEC-03) |
| Único admin do tenant sem MFA e sem acesso ao segundo fator | Não há saída pelo produto. É suporte da plataforma, e é a razão de a carência existir |
| Tenant suspenso **e** admin sem MFA | O gate de suspensão vem primeiro e responde `ERR_IDENT_008`. Os dois barram escrita; a mensagem que aparece é a que o admin resolve primeiro |
| Chamada pela porta interna (serviço não migrado) | Não passa por `resolveSession` e **não** é barrada por MFA. O contexto foi resolvido na porta de fora, onde o gate já rodou |
| Job escrevendo em nome de ninguém | Sem `authContext`, sem gate. Job não tem segundo fator |
| Filtro por `entityId` de outro tenant | Lista vazia, 200. Nunca 403 |
| Trilha de um tenant recém-criado | Lista vazia com estado vazio na tela, não erro |
| Expurgo com o banco sob carga | O teto de tempo corta a execução; o resto fica para amanhã |
| Relógio do servidor atrasado na virada da carência | Ninguém é barrado antes da hora, porque a comparação é `now() > mfa_grace_until` no banco, e o relógio é um só |

---

## 8. Eventos RabbitMQ

**Nenhum evento novo.** É deliberado: os dois consumidores plausíveis de um
`seguranca.evento_registrado` seriam o alerta ao administrador e o painel de plataforma,
e os dois são MOD-ADMIN. Publicar um evento que ninguém consome criaria fila órfã — e
`packages/service-kit/src/events.ts` publica best-effort depois do commit, então o evento
nem seria garantia de nada.

O que este módulo **consome** de outros: nada. Ele observa, não reage.

---

## 9. Segurança & LGPD

### Controle de Acesso

| Operação | TENANT_ADMIN | Demais papéis | Tutor (Portal) |
|---|---|---|---|
| Ler trilha de auditoria | ✓ | — | — |
| Ler eventos de segurança | ✓ | — | — |
| Ser exigido de MFA | ✓ | — | — |
| Ver o próprio estado de MFA (`/v1/me`) | ✓ | ✓ | — |

### Audit Log

**Este módulo quase não escreve na trilha, e é coerente com o que ela é.** Ler auditoria
não muda nada, e registrar toda leitura faria a trilha crescer com o ato de consultá-la.
Geram registro apenas: a **negação** de `audit:read` (pelo guarda comum, como toda
negação) e o **expurgo**, que grava uma linha de plataforma (`tenant_id` nulo) com a
contagem apagada por tabela — é o que permite responder "por que a linha de 2024 sumiu".

> A leitura da trilha por um administrador **não** é auditada na v1. Quando existir
> `support_access_grant` (MOD-ADMIN), o acesso da **plataforma** ao dado de um tenant
> passa a ser auditado por leitura, que é o caso em que isso importa.

### Dados Pessoais

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `audit_logs.actor_user_id` | dado pessoal (equipe) | legítimo interesse | 24 meses | — | por expurgo |
| `audit_logs.ip_address` / `user_agent` | dado pessoal (equipe) | legítimo interesse | 24 meses | — | por expurgo |
| `audit_logs.before` / `after` | pseudonimizado | legítimo interesse | 24 meses | — | por expurgo |
| `security_events.ip_address` / `user_agent` | dado pessoal | legítimo interesse | 24 meses | — | por expurgo |
| `memberships.mfa_grace_until` | não é dado pessoal | execução de contrato | vida do membership | — | com o membership |

> **A trilha não entra na exportação do titular, e não sai na anonimização dele.** Ela
> registra o que a **equipe** fez, não o que o tutor é — e `before`/`after` já teve a PII
> descartada por `sanitize()`. Um `tutor.anonymized` na trilha é justamente a prova de
> que a anonimização aconteceu; apagá-lo junto destruiria o registro do cumprimento.

> **A base legal do rastro de rede é legítimo interesse, e o interesse tem prazo.** IP e
> user-agent de um funcionário guardados para sempre não se sustentam como necessários; a
> mesma informação por vinte e quatro meses cobre qualquer disputa trabalhista ou
> incidente que alguém vá investigar. É a retenção que torna a base legal defensável, e é
> por isso que ela é parte do módulo e não um refino posterior.

---

## 10. Performance & Observabilidade

### Cache Redis

**Nenhuma chave nova.** A decisão de MFA sai do token, que já está em mãos, e a leitura
da trilha é sempre a consulta mais recente — cachear resultado de auditoria seria mostrar
uma trilha desatualizada a quem a abriu justamente para ver o que acabou de acontecer.

### Métricas (Pino estruturado)

- `mfa_write_blocked` — escritas recusadas por falta de segundo fator. Sobe no dia em que
  a carência vence e precisa cair na semana seguinte; se não cair, o caminho de
  enrolamento está quebrado.
- `mfa_claim_missing` — tokens sem o claim. **Qualquer valor diferente de zero é erro de
  configuração**, e é a métrica que denuncia o JWT template desatualizado (AC-02 de
  MOD-SEC-01).
- `security_event_recorded` — por tipo. `TENANT_CONTEXT_MISSING` acima de zero é
  incidente: uma consulta escapou do `withTenant`.
- `audit_retention_deleted` — linhas apagadas por passada, por tabela. Zero por vários
  dias seguidos, com a tabela grande, quer dizer que o job não está apagando.

### Consultas

A listagem da trilha usa o índice `(tenant_id, created_at DESC)` que já existe, com
cursor por `(created_at, id)` — nunca `OFFSET`, que na página 40 varre as 39 anteriores.
O SLO é p95 de 300ms na primeira página com janela de 30 dias.

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | O `MANAGER` do SPEC §7.2 não existe como papel no produto — a matriz tem `TENANT_ADMIN` e `RECEPTIONIST`. Estender a exigência a "quem configura" exigiria decidir se `RECEPTIONIST` conta | Alcance do MOD-SEC-02 | Product | Antes da Fase 8 |
| 2 | O único administrador sem acesso ao segundo fator hoje depende de suporte manual. Um caminho de recuperação no produto (código de backup, segundo admin obrigatório) é frente própria | Suporte | Product | Depois do primeiro incidente |
| 3 | Promover a CSP de `Report-Only` para valendo depende de uma semana de relatório limpo. Falta decidir **para onde** o relatório vai — não há endpoint de coleta | MOD-SEC-09 | Tech Lead | Uma semana após o deploy |
| 4 | A leitura da trilha pela plataforma (cross-tenant, por `app_maintenance`) não tem superfície. É MOD-ADMIN, e até lá a investigação é por `psql` | Operação | Tech Lead | MOD-ADMIN |
| 5 | Retenção de 24 meses é a mesma do MOD-NOTIF, escolhida por coerência e não por exigência legal. Um cliente com política própria não tem como configurá-la | Compliance | Product | Quando houver contrato que exija |
| 6 | O expurgo apaga linha de `audit_logs` que sustenta a prova de uma anonimização de 2024. Se a retenção de prova de LGPD precisar exceder 24 meses, é aqui que se descobre | Compliance | Legal | Antes do primeiro aniversário de dois anos |
