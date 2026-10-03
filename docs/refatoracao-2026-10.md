# Refatoração de 2026-10 — o que mudou e por quê

Registro da refatoração guiada pelo [`REFACTOR.md`](../REFACTOR.md), feita em 2026-10-03:
auditoria primeiro e depois nove fases, uma por vez, cada uma validada com lint, typecheck e
a suíte inteira antes da seguinte. É **incremental e preserva o comportamento**: nenhuma
fase reescreveu módulo. As regras que valem daqui em diante estão no `CLAUDE.md`; aqui fica
o histórico, com o motivo de cada decisão.

## As fases

| Fase | O que mudou | Por quê |
|---|---|---|
| 1. Segurança crítica | next 15.5.27, fastify 5.12.5, sharp 0.35.5; overrides de `fast-uri`, `postcss` e `sharp`; `images.unoptimized`; JSON-LD do site escapado (`json-ld.ts`) | Dependências com vulnerabilidade conhecida — uma delas uma RCE no otimizador de imagem, que nenhuma tela usava — e um `</script>` vindo do cadastro do petshop que fechava a tag do JSON-LD |
| 2. Fila confiável | `shared/event-consumer.ts`: um mecanismo de consumo para todos os módulos, com retentativa **com a mensagem retida** (1, 2, 4, 8 s) e a fila `petshop.events.dead` ligada à DLX | A falha que não passava sumia: a DLX não tinha fila. E uma fila de retry entregaria fora de ordem eventos que gravam saldo absoluto |
| 3. Configuração | `envFlag()` no lugar de `z.coerce.boolean()`; `z.stringbool()` no `?unassigned` do táxi; serializador de `err` no logger; teto das Server Actions de 100 MB para 11 MB, com o do middleware junto; álbum do pet envia uma foto por chamada | `DISABLE_JOBS=false` desligava os jobs; todo erro saía `[redacted]` no log; o middleware truncava em 10 MB todo envio de várias fotos |
| 4. Rate limit antes da autenticação | `auth/auth-failures.ts` (token recusado por petshop×IP, só no Portal); JWKS na memória do processo e `kid` desconhecido sem ida à rede | O rate limit contava depois da autenticação, e o 401 nunca era contado; cada token com `kid` inventado virava uma chamada à API do Clerk |
| 5. Testes de proteção e CI | `rls-catalog.test.ts`, `anonymous-routes.test.ts`, `.github/workflows/ci.yml`; `TutorCharge` e `EmailDomain` em `RLS_MODELS`; `next typegen` no typecheck do frontend | Não havia CI. O primeiro checkout limpo achou o lint do `api-client` vermelho, o cliente do Prisma faltando, os tipos de rota ausentes e um teste de RLS vermelho havia uma semana |
| 6. Sobras do HMAC | `packages/service-auth` removido; `ServiceAuthContext` no `service-kit`; `INTERNAL_SERVICE_SECRET` fora do schema e dos exemplos de ambiente | Contrato entre serviços sem leitor desde a consolidação, exigido na subida e derrubando o deploy quando faltava |
| 7. Arquivo-deus | `api-client` dividido em `transport.ts` e `endpoints/<domínio>.ts` | 3.107 linhas num arquivo; a divisão foi por script, e o compilador provou que os 302 métodos têm o mesmo tipo de antes |
| 8. Moldura do Admin | `GET /v1/me/pending` (`gateway/pending.ts`); fuso no `/v1/me`; Início só com Movimento, Financeiro e Sua base | Onze chamadas por navegação viraram duas. O `getSettings` da moldura dava 403 a quem não é administrador — fuso errado na saudação e uma negação gravada na trilha a cada tela |
| 9. Documentação | `CLAUDE.md`, `README.md` e este arquivo | — |

## Decisões que não são óbvias pelo código

- **O sino chama as rotas por dentro (`app.inject`) em vez de importar as funções.** Duas
  das nove contagens só existem dentro do handler da rota, e importar a função de cada
  módulo seria o import solto entre módulos que a arquitetura proíbe. Por dentro, a regra é
  a mesma da rota — inclusive o gate de plano e o RLS.
- **O limite de tokens recusados vale só para o Portal.** O Admin é chamado pelo servidor do
  Next, com um IP só para todos os estabelecimentos; contar por IP ali trancaria todo mundo
  num soluço do Clerk.
- **Só o `api-client` foi dividido.** Os outros arquivos de ~1.000 linhas são catálogos
  coesos (eventos, schemas, textos de mensagem) ou telas. Dividir tela sem teste de
  interface é risco sem ganho medido.
- **O envio de fotos deixou de ser tudo ou nada.** Uma por chamada: se a cota do plano
  acabar no meio, as já enviadas ficam, e a tela diz quantas foram.

## Pendências

- **Tirar `INTERNAL_SERVICE_SECRET` dos três composes** (`infra/docker-compose.*.yml`).
  Ficou como opcional (`${…:-}`) porque as imagens anteriores à Fase 6 ainda o exigem na
  subida, e um rollback para elas não subiria sem ele. Sai quando nenhuma for mais
  candidata a rollback.
- **Formatação herdada.** Vários arquivos do repositório não seguem o prettier desde antes
  da refatoração (`app.ts` do backend, alguns testes). Ficaram como estavam: reformatá-los
  junto com uma mudança de comportamento esconderia a mudança no diff.
- **Telas grandes sem teste de interface** (`financeiro-tab.tsx`, `pet-detail.tsx`,
  `settings-form.tsx`, ~1.100–1.250 linhas). Dividir pede teste antes.
- **Verificar no primeiro push** que o CI sobe como na simulação local: o cache do pnpm e
  o Postgres de serviço do runner são as duas partes que só o GitHub exercita.
