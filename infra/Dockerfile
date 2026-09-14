# syntax=docker/dockerfile:1.7
#
# Imagens de produção do PetShop AI. Três alvos, um estágio de build compartilhado:
#
#   --target backend   o backend Fastify (um processo, todos os módulos)
#   --target frontend  o Next em modo standalone
#   --target migrator  roda `migrate deploy` + seed e morre
#
# Uma imagem só porque o backend é um processo só: a consolidação em monólito modular
# fechou na fatia 11 e os doze serviços viraram `backend/app`, com as fronteiras de
# módulo em `src/modules/*` — ver o CLAUDE.md. O `command` do container ainda nomeia o
# server.js porque em Swarm ele carrega o gate de migração na frente.
#
# Build a partir da RAIZ do monorepo:
#   docker build -f infra/Dockerfile --target backend -t petshop/backend .

ARG NODE_VERSION=22

# ─── base ─────────────────────────────────────────────────────────────────────
# Debian slim, e não Alpine: o engine do Prisma é compilado por alvo e o binário
# musl costuma cobrar depuração. glibc é o caminho previsível.
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
# `postgresql-client` existe por causa do Swarm: lá o `depends_on` é ignorado, e
# `infra/swarm/aguardar-migracao.sh` — o gate que substitui o
# `service_completed_successfully` do compose — pergunta ao banco quantas migrações
# já entraram. Uma pergunta em SQL resolve as três coisas de uma vez (o Postgres
# atende? a role app_user existe? o schema está no ponto?); reimplementá-la em Node
# custaria mais do que os ~15 MB do cliente.
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl postgresql-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm --filter "@petshop/db" generate
# `--concurrency=2` sobrescreve o `concurrency: 20` do turbo.json. Aquele número
# serve à máquina de desenvolvimento; aqui dentro são 4 CPUs e 4 GB, e vinte `tsc`
# em paralelo saturam a VM do Docker a ponto de nem `docker version` responder —
# o build não falha, trava. Dois por vez é mais lento e termina.
# O `api-client` fecha a lista sem ser um serviço: ele é dependência apenas do
# frontend, que resolve tudo pela condição `default` ao empacotar. Sem ele aqui
# o `dist` prometido no `exports` nunca é emitido, e o verificar-exports abaixo
# — que confere os pacotes, não só os serviços — reprova o build.
RUN pnpm build --concurrency=2 \
      --filter="@petshop/app" \
      --filter="@petshop/api-client"

# A condição `petshop-dist` do campo `exports` só é exercitada aqui dentro — em
# desenvolvimento vale sempre a `default`, que aponta para o .ts de origem. Um
# caminho errado ali passa pela suíte, pelo `tsc` e pelo `pnpm dev`, e só aparece
# no container, como ERR_MODULE_NOT_FOUND no primeiro import. Com `start-first`,
# aparece depois de o deploy já ter começado a substituir o que funcionava.
RUN node scripts/verificar-exports.mjs

# ─── frontend-build ───────────────────────────────────────────────────────────
# Estágio à parte, e não uma linha a mais em `build`, por causa do cache: a chave
# publicável do Clerk muda por instância, e se ela vivesse no estágio comum toda
# troca de ambiente invalidaria também a compilação do backend.
FROM build AS frontend-build

# Esta chave PRECISA existir no build. É o SDK React do Clerk que a exige, e o
# prerender de `/_not-found` falha sem ela. É `pk_`, publicável por definição —
# vai para o bundle do browser de qualquer forma, então não é segredo vazando
# para uma camada de imagem. A consequência a aceitar: a imagem do frontend fica
# amarrada a uma instância do Clerk, diferente das do backend.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

# `next build` direto, e não `pnpm --filter @petshop/frontend build`: o script do
# pacote passa por `dotenv -e ../.env`, e o .env não entra na imagem (nem deve).
# Sem NEXT_DIST_DIR o distDir volta a ser `.next`, que é o que o standalone usa.
RUN test -n "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
    || (echo "ERRO: build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY é obrigatório" && exit 1) \
  && pnpm --filter "@petshop/frontend" exec next build

# ─── migrator ─────────────────────────────────────────────────────────────────
# Herda do build porque PRECISA das dependências de desenvolvimento: o `prisma`
# CLI e o `tsx` que roda o seed são devDependencies. Sobe uma vez por deploy,
# antes dos serviços, e termina.
FROM build AS migrator
ENV NODE_ENV=production
# Quatro passos, nesta ordem, e a composição só libera os serviços se todos passarem:
#   0. database da Evolution — em produção não há `docker-entrypoint-initdb.d`
#                         montado, então o `postgres/init/*.sql` que resolve isso em
#                         desenvolvimento não roda. Só o owner cria database, e o
#                         migrator é o único que conecta como ele. Idempotente.
#   1. migrate deploy   — schema, políticas de RLS, triggers
#   2. senhas das roles — a migration cria app_user com senha 'app_user'; produção
#                         não pode ficar assim, e só o owner consegue trocar
#   3. seed             — permissões e catálogo global (idempotente)
# O `until pg_isready` existe para o Swarm, onde não há `depends_on`: sem ele o
# migrator perde a corrida com o Postgres num deploy novo e o Swarm o reinicia às
# cegas, misturando "o banco ainda não subiu" com "a migração falhou" no mesmo log.
# `PG_URL` é a `DATABASE_URL` SEM a query string, e ela existe por um motivo
# concreto: `?schema=public` é parâmetro do **Prisma**, e o libpq — que é quem
# `pg_isready` e `psql` usam — recusa parâmetro que não conhece:
#
#     pg_isready: error: invalid URI query parameter: "schema"   (exit 3)
#
# Com o `2>&1` que havia aqui antes, esse erro ia para /dev/null e o laço girava
# para sempre repetindo "esperando o Postgres…" contra um banco que estava
# saudável o tempo todo. O Prisma continua recebendo a `DATABASE_URL` inteira.
#
# O teto de 60 tentativas troca o laço infinito por uma falha legível: o
# `depends_on` do compose já garante que o Postgres está saudável antes disto
# rodar, então dois minutos sem resposta é configuração errada, não partida lenta.
CMD ["sh", "-c", "set -e; \
  PG_URL=\"${DATABASE_URL%%\\?*}\"; \
  i=0; \
  until pg_isready -d \"$PG_URL\" >/dev/null 2>&1; do \
    i=$((i+1)); \
    if [ $i -gt 60 ]; then \
      echo 'migrator: o Postgres não respondeu em 120s. Erro real:'; \
      pg_isready -d \"$PG_URL\" || true; \
      exit 1; \
    fi; \
    echo \"migrator: esperando o Postgres… ($i/60)\"; \
    sleep 2; \
  done; \
  psql \"$PG_URL\" -tAc \"SELECT 1 FROM pg_database WHERE datname = 'evolution'\" | grep -q 1 \
    || psql \"$PG_URL\" -c 'CREATE DATABASE evolution'; \
  pnpm --filter @petshop/db exec prisma migrate deploy; \
  pnpm --filter @petshop/db exec tsx prisma/set-role-passwords.ts; \
  pnpm --filter @petshop/db exec tsx prisma/seed.ts"]

# ─── backend ──────────────────────────────────────────────────────────────────
FROM base AS backend
ENV NODE_ENV=production

COPY --from=build /app /app

# Poda tsc, vitest, eslint, prisma CLI e tsx. `--ignore-scripts` é seguro aqui:
# o client do Prisma tem `output` próprio (packages/db/generated) e já veio
# gerado do estágio de build, então não há postinstall a executar.
# `CI=true` porque a poda reinstala node_modules do zero e o pnpm, fora de CI,
# para para pedir confirmação — o build travaria esperando um "y" que nunca vem.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  CI=true pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm/store

# O tsconfig de cada serviço inclui `tests/**` para o typecheck, então o `dist`
# carrega os testes compilados. Nada os importa em produção; também não têm por
# que viajar. O frontend tem imagem própria.
RUN find /app/backend -type d -name tests -path '*/dist/*' -prune -exec rm -rf {} + \
  && rm -rf /app/frontend

# O bit de execução não sobrevive a todo caminho de checkout (Windows, tarball,
# `git config core.fileMode false`), e sem ele o container morre no arranque com
# "permission denied" — depois de o Swarm já ter tirado a versão anterior do ar.
RUN chmod +x /app/infra/swarm/*.sh

# A condição que faz `@petshop/*` resolver para o JavaScript compilado em vez do
# TypeScript de origem (campo `exports` de cada pacote). Sem ela o Node tenta
# carregar `packages/*/src/index.ts` e o processo morre no primeiro import.
ENV NODE_OPTIONS="--conditions=petshop-dist"

USER node
EXPOSE 3000
# Cada container sobrescreve com o seu serviço; o gateway é só o padrão sensato.
CMD ["node", "backend/app/dist/src/server.js"]

# ─── frontend ─────────────────────────────────────────────────────────────────
# O standalone já traz o subconjunto de node_modules que o servidor carrega, então
# esta imagem não instala nada: são só os arquivos que o Next apontou.
FROM base AS frontend
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0

COPY --from=frontend-build /app/frontend/.next/standalone ./
COPY --from=frontend-build /app/frontend/.next/static ./frontend/.next/static

USER node
EXPOSE 3002
CMD ["node", "frontend/server.js"]
