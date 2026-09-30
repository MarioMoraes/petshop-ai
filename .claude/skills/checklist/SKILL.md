---
name: checklist
description: "Checklist de segurança do PetShop AI: varre o código atrás de cinco classes de brecha — (1) tabela sem RLS, (2) autorização decidida no frontend, (3) busca por ID sem checar o dono (IDOR), (4) segredo/API key exposto no código ou no bundle, (5) input sem validação e upload sem checar tipo — e lista cada achado com arquivo, linha e como corrigir. Use quando o usuário pedir /checklist, auditoria de segurança, varredura de vulnerabilidades ou 'checklist de segurança'."
---

# Checklist de segurança

Varredura **só de leitura**: não altera código. O produto é um relatório com cada achado
em arquivo:linha e a correção. Corrigir fica para depois, se o usuário pedir.

## Escopo

- Sem argumento: o repositório inteiro.
- Com argumento: um caminho (`backend/app/src/modules/cash`) ou um ponto do git
  (`main`, `HEAD~5`). Com ponto do git, varra só os arquivos de
  `git diff --name-only <ponto>...HEAD`, **mas o item (1) roda sempre inteiro**: uma
  tabela nova sem RLS mora numa migration, e a regra se confere contra o schema todo.

## Antes de começar: como este repositório se defende

Os cinco itens se leem contra as defesas que já existem. Um achado que as ignore é falso
positivo. Confira que continuam valendo (os nomes podem ter mudado):

| Camada | Onde | O que garante |
|---|---|---|
| RLS | `packages/db/prisma/migrations/*/migration.sql` | `ENABLE` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY` com `current_setting('app.tenant_id')` |
| Cliente do banco | `packages/db/src/client.ts` | `prisma` conecta como `app_user` (sem BYPASSRLS) e só funciona dentro de `withTenant()`; `maintenancePrisma` (`app_maintenance`, COM BYPASSRLS) é para jobs e plataforma |
| Porta de entrada | `backend/app/src/auth/session.ts` | token do Clerk → tenant + papel + permissões, gate de MFA e de estado da conta |
| Superfícies | `backend/app/src/gateway/routes.ts` | pública × autenticada é **escopo do Fastify**: rota registrada fora do escopo autenticado nasce aberta |
| Permissão | `modules/*/auth.ts` (`requirePermission`, `requireTenantContext`) | matriz de papéis no servidor |
| Portal | `modules/portal/routes.ts`, `requireOwnScope` | o `tutorId` sai da sessão, nunca do corpo |
| Validação | schemas Zod em cada rota | forma e defaults do corpo, query e params |
| Borda | `infra/Caddyfile` (matcher `@api`) | só webhooks, `/portal/v1` e catálogo chegam da internet |

Consulte o grafo antes de ler arquivo por arquivo (`graphify explain "withTenant"`,
`graphify query "upload multipart"`); ele diz onde olhar, e a leitura decide.

## Os cinco itens

Rode os cinco em sequência. Para cada candidato, **leia o trecho** antes de registrar:
um grep acha suspeitos, não achados.

### (1) Tabelas sem RLS

```bash
.claude/skills/checklist/scripts/rls.sh
```

O script lista toda tabela do `schema.prisma` a que falte `ENABLE`, `FORCE` ou uma
`POLICY` nas migrations, e se ela tem `tenant_id`. Triagem:

- **Tem `tenant_id` e falta proteção** → achado ALTO, a menos que um comentário na
  migration ou no schema diga que só `maintenancePrisma` a toca (é o caso das tabelas da
  plataforma). Nesse caso, confirme com
  `grep -rn "<model>\." backend/app/src` que nenhum acesso passa pelo `prisma` de
  requisição.
- **Sem `tenant_id`** (catálogo global, `users`, `roles`, lease de job) → não é achado
  por si. Só vira achado se o conteúdo for de um tenant, ou se `app_user` tiver
  `GRANT` de escrita que não devia ter (procure `GRANT` nas migrations).
- Também conte como achado: `ENABLE` sem `FORCE` (o dono da tabela ignora a política),
  política com `USING (true)`, e policy que lê o tenant de algo diferente de
  `current_setting('app.tenant_id')`.
- Fora do banco: uso de `maintenancePrisma` ou `$queryRawUnsafe` em código de requisição
  (`grep -rn "maintenancePrisma\|queryRawUnsafe\|executeRawUnsafe" backend/app/src`),
  porque ele passa por cima do RLS.

**Correção típica:** migration nova com
`ALTER TABLE "x" ENABLE ROW LEVEL SECURITY; ALTER TABLE "x" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "x" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (...)`
(copie o modelo da migration `*_rls_policies` mais recente), e o acesso passa por
`withTenant()`.

### (2) Autorização decidida no frontend

O frontend pode **esconder** um botão; quem **decide** é o servidor. O achado é o caso em
que só o frontend decide.

1. Liste as decisões do frontend:
   `grep -rnE "platformAdmin|permissions?\.|hasPermission|temRecurso|role ?===|papel|isAdmin" frontend/src app/lib --include=*.ts --include=*.tsx`
2. Para cada uma que esconde uma ação ou uma tela, ache a rota do backend que a ação
   chama (Server Action em `actions.ts` → `lib/api.ts` → rota) e confirme que a rota
   exige a mesma coisa (`requirePermission('...')`, plano em `PLAN_GATES`,
   `platform_admins`).
3. Procure também:
   - Server Action (`'use server'`) que monta a chamada com dado vindo do cliente que
     decide acesso (`tenantId`, `role`, `userId` no argumento);
   - `middleware.ts` como única barreira de uma rota de dado (o middleware redireciona,
     não autoriza);
   - rota nova em `src/app` fora de `ADMIN_ROUTE_PREFIXES` (`lib/host.ts`);
   - rota Fastify registrada fora do escopo autenticado em `gateway/routes.ts`, ou
     handler sem `requirePermission`/`requireTenantContext`;
   - no app Flutter (`app/lib`), tela ou ação liberada por um campo do modelo sem que a
     rota do Portal confira.

**Correção típica:** exigir a permissão no handler (`requirePermission`) ou registrar a
rota no escopo certo; o frontend continua escondendo, mas agora é só apresentação.

### (3) IDOR — busca por ID sem checar o dono

1. Liste as rotas com parâmetro:
   `grep -rnE "\.(get|put|patch|delete|post)\(\s*['\`][^'\`]*:[a-zA-Z]+" backend/app/src/modules`
2. Para cada uma, siga até a consulta e confirme **uma** destas:
   - a consulta roda em `withTenant()` sobre tabela com RLS (o isolamento entre tenants
     vem do banco), **e**
   - dentro do tenant, quando o recurso tem dono mais estreito — o tutor no Portal, o
     profissional numa ação "só a própria agenda", o autor de um rascunho —, o `where`
     inclui o dono vindo da sessão (`requireOwnScope`, `ctx.userId`), e não do corpo.
3. Achados comuns:
   - `findUnique({ where: { id } })` com `maintenancePrisma`, ou em tabela sem RLS;
   - Portal que aceita `petId`/`appointmentId`/`documentId` e não cruza com o
     `tutorId` da sessão;
   - dono vindo do corpo ou da query (`body.tutorId`, `query.userId`);
   - relação aninhada: o pai foi conferido, o filho do parâmetro seguinte não
     (`/pets/:petId/photos/:photoId` que busca a foto só por `photoId`);
   - URL de arquivo (R2, PDF) previsível ou sem expiração.

**Correção típica:** `where: { id, tutorId: scope.tutorId }` (ou `findFirst` com os dois),
responder 404 — não 403 — quando não casar, para não confirmar que o ID existe.

### (4) Segredos e API keys expostos

1. Arquivos versionados:
   `git ls-files | grep -iE "\.env($|\.)|\.pem$|\.p12$|\.key$|credentials|service-account|google-services\.json|GoogleService-Info"`
   (os `.env.example` são permitidos; confira que só têm placeholder).
2. Padrões de chave no conteúdo versionado:
   `git grep -nIE "sk-ant-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|pk_live_|re_[A-Za-z0-9]{20,}|\\\$aact_|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|whsec_[A-Za-z0-9]{20,}|xox[bap]-"`
   e atribuições literais:
   `git grep -nIE "(secret|password|senha|api_?key|token)\s*[:=]\s*['\"][^'\"]{12,}['\"]" -- ':!*.test.*' ':!*.md'`
3. Bundle do navegador: toda `NEXT_PUBLIC_*` vai para o cliente.
   `grep -rnoh "NEXT_PUBLIC_[A-Z_]*" frontend/src | sort -u` — só pode haver URL e chave
   **publicável**. Também é achado: arquivo `'use client'` que importa `process.env.X`
   sem `NEXT_PUBLIC_` (vem vazio, mas mostra a intenção de usar segredo no cliente), ou
   que importa módulo `*.server.ts`/que usa o token do Clerk.
   Se houver build (`frontend/.next/static`), confirme:
   `grep -rlE "sk-ant-|sk_live_|re_[A-Za-z0-9]{20}|\\\$aact_" frontend/.next/static`.
4. App Flutter: `git grep -nIE "(apiKey|secret|token)\s*[:=]" app/lib` e
   `--dart-define` em scripts versionados.
5. Histórico: um segredo removido continua no git.
   `git log -p -S "sk-ant-" --all | head` (repita para os prefixos do passo 2 que
   tiverem aparecido).
6. Logs: `grep -rnE "log(ger)?\.(info|debug|warn|error)\(.*(apiKey|token|secret|password|authorization)" backend/app/src`.

**Correção típica:** mover para variável de ambiente lida só no servidor, **rotacionar a
chave** (remover do código não basta se ela já foi comitada), e acrescentar o arquivo ao
`.gitignore`. Chave por tenant fica cifrada com a DEK, como `agent/api-key.ts`.

### (5) Input sem validação e upload sem checar tipo

**Validação:**
1. Toda rota Fastify deve validar `body`, `querystring` e `params` com Zod antes de usar:
   procure handler que lê `request.body`/`request.query`/`request.params` sem `.parse(`
   / `safeParse(` / `schema:` na definição.
2. Server Actions: `formData.get(...)` usado direto, sem schema, antes de ir à API.
3. SQL cru: `$queryRawUnsafe`/`$executeRawUnsafe` ou template com `${}` montado fora do
   `Prisma.sql`.
4. HTML: `dangerouslySetInnerHTML` (frontend), `Html(`/`HtmlWidget` (Flutter) e
   templates de PDF/e-mail que interpolam texto do usuário sem escape
   (`packages/pdf`, `packages/documents`, `modules/messaging`).
5. Outros sinks: `new RegExp(input)`, `redirect(input)`/`Location` com URL do usuário
   (open redirect), `fetch(input)` no servidor (SSRF — webhooks e URLs de integração),
   `child_process`, caminho de arquivo montado com input.
6. Webhooks em `/internal/`: confirmar que cada um confere a assinatura ou o token
   **sobre o corpo cru** antes de parsear.

**Upload:**
`grep -rn "multipart\|request.file\|saveRequestFiles\|FormData\|putObject\|PutObjectCommand" backend/app/src frontend/src`.
Para cada ponto, confirme:
- tipo checado pelos **bytes** (assinatura mágica: `ffd8ff` JPEG, `89504e47` PNG,
  `52494646....57454250` WEBP, `25504446` PDF), e não só pela extensão ou pelo
  `mimetype` que o cliente mandou;
- lista de tipos permitidos (allowlist), nunca bloqueio de alguns;
- tamanho máximo (`limits.fileSize`) e número de arquivos;
- nome do objeto gerado pelo servidor (UUID), nunca o `filename` do cliente;
- `Content-Type` gravado no storage vindo do tipo detectado, e SVG/HTML recusados
  (executam script quando servidos inline);
- CSV do MOD-IMPORT: células que começam com `=`, `+`, `-`, `@` não voltam para planilha
  sem escape (CSV injection).

**Correção típica:** schema Zod na rota; para upload, ler os primeiros bytes, conferir
contra a allowlist, recusar com 415 o resto, e gravar com nome UUID e o tipo detectado.

## O relatório

Depois dos cinco itens, responda **em português**, nesta forma:

```
## Checklist de segurança — <escopo>, <data>

Resumo: N achados (A alto, M médio, B baixo). Itens sem achado: (x), (y).

### (1) Tabelas sem RLS
| Sev. | Arquivo:linha | Achado | Como corrigir |
|---|---|---|---|
| ALTO | packages/db/prisma/schema.prisma:452 | `platform_metrics` tem tenant_id e nenhuma policy; `modules/x/y.ts:30` a lê com `prisma` | migration com ENABLE+FORCE+POLICY, ou ler só via maintenancePrisma no console |

### (2) … (3) … (4) … (5) …

### Verificado e descartado
- <candidato> — por que não é brecha (ex.: tabela global sem dado de tenant; rota sob `requirePermission` no escopo autenticado).
```

Regras do relatório:
- **Arquivo:linha clicável** e real — confira a linha com `grep -n` antes de escrever.
- Severidade: **ALTO** = dado de outro tenant/tutor alcançável, segredo real exposto,
  execução de código; **MÉDIO** = depende de outra falha ou de papel interno;
  **BAIXO** = endurecimento.
- Nunca imprima o valor de um segredo encontrado: mostre os 4 primeiros caracteres e
  `…`.
- A seção **Verificado e descartado** é obrigatória quando houve candidatos: mostra que o
  item foi olhado, e evita que a próxima rodada reinvestigue o mesmo.
- Item sem nenhum achado aparece com "nenhum achado" e o que foi conferido.
- Não altere código. Ao final, ofereça corrigir os achados ALTO.
