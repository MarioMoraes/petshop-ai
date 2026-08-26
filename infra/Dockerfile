# syntax=docker/dockerfile:1.7
#
# Imagens de produção do PetShop AI. Três alvos, um estágio de build compartilhado:
#
#   --target backend   sete serviços Fastify numa imagem só
#   --target frontend  o Next em modo standalone
#   --target migrator  roda `migrate deploy` + seed e morre
#
# Uma imagem para os sete serviços porque eles compartilham as MESMAS dependências
# (fastify, prisma, ioredis, amqplib): sete imagens seriam o mesmo node_modules
# multiplicado por sete. O `command` de cada container escolhe qual server.js sobe
# — ver infra/docker-compose.prod.yml.
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
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm --filter "@petshop/db" generate
RUN pnpm build --filter="@petshop/api-gateway" \
      --filter="@petshop/identity-service" \
      --filter="@petshop/tutor-service" \
      --filter="@petshop/pet-service" \
      --filter="@petshop/medical-record-service" \
      --filter="@petshop/scheduling-service" \
      --filter="@petshop/billing-ledger-service"

# ─── frontend-build ───────────────────────────────────────────────────────────
# Estágio à parte, e não uma linha a mais em `build`, por causa do cache: a chave
# publicável do Clerk muda por instância, e se ela vivesse no estágio comum toda
# troca de ambiente invalidaria também a compilação dos sete serviços.
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
# Três passos, nesta ordem, e a composição só libera os serviços se todos passarem:
#   1. migrate deploy   — schema, políticas de RLS, triggers
#   2. senhas das roles — a migration cria app_user com senha 'app_user'; produção
#                         não pode ficar assim, e só o owner consegue trocar
#   3. seed             — permissões e catálogo global (idempotente)
CMD ["sh", "-c", "set -e; \
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

# A condição que faz `@petshop/*` resolver para o JavaScript compilado em vez do
# TypeScript de origem (campo `exports` de cada pacote). Sem ela o Node tenta
# carregar `packages/*/src/index.ts` e o processo morre no primeiro import.
ENV NODE_OPTIONS="--conditions=petshop-dist"

USER node
EXPOSE 3000
# Cada container sobrescreve com o seu serviço; o gateway é só o padrão sensato.
CMD ["node", "backend/api-gateway/dist/src/server.js"]

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
