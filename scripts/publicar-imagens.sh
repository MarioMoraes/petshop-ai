#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 1 do deploy — roda na SUA MÁQUINA (Mac).
#
#   bash scripts/publicar-imagens.sh 0.1.0
#
# Constrói as quatro imagens e as publica no ghcr.io. Depois, na VPS:
#   cd /opt/petshop && bash scripts/atualizar-vps.sh 0.1.0
#
# Por que aqui e não na VPS: `docker stack deploy` ignora `build:`, então a imagem
# precisa existir num registry de qualquer forma. E o build deste monorepo
# (pnpm install + dez serviços + `next build`) pede uns 4 GB de RAM — tirá-lo da
# VPS é o que permite rodar tudo numa máquina modesta.
#
# ── Sobre o Mac com Apple Silicon ─────────────────────────────────────────────
# A VPS é x86_64 e o seu Mac provavelmente é arm64. `--platform linux/amd64` é
# obrigatório: sem ele a imagem sobe, o Swarm a aceita, e o container morre com
# "exec format error" — depois de o deploy já ter começado.
# A emulação cobra caro; o primeiro build passa dos 20 minutos.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

VERSAO=${1:-}
if [ -z "$VERSAO" ]; then
  echo "uso: bash scripts/publicar-imagens.sh <versao>   (ex.: 0.1.0)" >&2
  exit 1
fi

REGISTRY=${REGISTRY:-ghcr.io}
NAMESPACE=${GHCR_NAMESPACE:-mariomoraes}
PLATAFORMA=${PLATAFORMA:-linux/amd64}
PREFIXO="$REGISTRY/$NAMESPACE/petshop"

BACKEND_IMAGE="$PREFIXO-backend:$VERSAO"
FRONTEND_IMAGE="$PREFIXO-frontend:$VERSAO"
MIGRATOR_IMAGE="$PREFIXO-migrator:$VERSAO"
CADDY_IMAGE="$PREFIXO-caddy:$VERSAO"

# ── Guardas ───────────────────────────────────────────────────────────────────
# Uma imagem construída de um working tree sujo não corresponde a commit nenhum.
# Quando ela quebrar em produção não haverá o que ler para descobrir o porquê.
if [ -n "$(git status --porcelain)" ]; then
  echo "ERRO: há alterações não commitadas. Commite (ou guarde) antes de publicar." >&2
  git status --short >&2
  exit 1
fi

if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
  echo "ERRO: há commits locais não enviados. Rode 'git push' antes." >&2
  echo "      A VPS puxa o compose e os scripts do GitHub, não da sua máquina." >&2
  exit 1
fi

# A chave publicável do Clerk é ASSADA no bundle do navegador durante o build.
# Trocá-la depois, no ambiente do container, não tem efeito nenhum — por isso ela
# é lida aqui. Precisa ser a MESMA que está no .env.production da VPS.
PK=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}
if [ -z "$PK" ] && [ -f .env.production ]; then
  PK=$(grep -m1 '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env.production | cut -d= -f2- | tr -d '"' || true)
fi
if [ -z "$PK" ]; then
  echo "ERRO: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY não encontrada." >&2
  echo >&2
  echo "      Ela é assada no bundle do browser em tempo de BUILD, e o build é aqui —" >&2
  echo "      por isso a chave precisa existir NESTA máquina. O .env.production mora" >&2
  echo "      na VPS e normalmente não existe aqui; não é de lá que este script lê." >&2
  echo >&2
  echo "      Para reaproveitar a chave de desenvolvimento (fase de testes):" >&2
  echo "        export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=\$(grep -m1 '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env | cut -d= -f2- | tr -d '\"')" >&2
  echo >&2
  echo "      Ou exporte a chave da instância de produção:" >&2
  echo "        export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_..." >&2
  echo >&2
  echo "      Seja qual for, o .env.production da VPS precisa ter ESTA MESMA pk_ e o" >&2
  echo "      sk_ correspondente: frontend e backend têm de falar com a mesma" >&2
  echo "      instância do Clerk, ou todo login vira 401 depois do deploy." >&2
  exit 1
fi
case "$PK" in
  pk_live_*) ;;
  # Publicar a chave de teste é o erro silencioso caro: o app sobe, a tela de
  # login aparece, e as contas criadas vão para a instância errada do Clerk.
  *) echo "AVISO: a chave do Clerk não começa com 'pk_live_' — é a de teste?" >&2 ;;
esac

echo "→ versão   $VERSAO"
echo "→ registry $PREFIXO-*"
echo "→ arch     $PLATAFORMA"
echo

# ── Build ─────────────────────────────────────────────────────────────────────
# Os quatro alvos, na ordem em que o cache os favorece: `backend` e `migrator`
# saem do mesmo estágio `build`, e `frontend-build` herda dele.
echo "→ backend"
docker build --platform "$PLATAFORMA" -f infra/Dockerfile --target backend \
  -t "$BACKEND_IMAGE" .

echo "→ migrator"
docker build --platform "$PLATAFORMA" -f infra/Dockerfile --target migrator \
  -t "$MIGRATOR_IMAGE" .

echo "→ frontend"
docker build --platform "$PLATAFORMA" -f infra/Dockerfile --target frontend \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$PK" \
  -t "$FRONTEND_IMAGE" .

# Contexto: a raiz, como os outros três. Era `infra/` enquanto a imagem só levava
# o Caddyfile; a landing de venda (`frontend/landing-page`) entrou nela e está
# fora daquela pasta.
echo "→ caddy (com o módulo DNS da Cloudflare — é o que emite o wildcard)"
docker build --platform "$PLATAFORMA" -f infra/Dockerfile.caddy \
  -t "$CADDY_IMAGE" .

# ── Push ──────────────────────────────────────────────────────────────────────
echo
echo "→ publicando no $REGISTRY"
docker push "$BACKEND_IMAGE"
docker push "$MIGRATOR_IMAGE"
docker push "$FRONTEND_IMAGE"
docker push "$CADDY_IMAGE"

# A tag marca qual commit virou qual versão. Sem ela, "voltar para a anterior"
# vira arqueologia.
if git rev-parse "v$VERSAO" >/dev/null 2>&1; then
  echo "(tag v$VERSAO já existe, mantida)"
else
  git tag "v$VERSAO"
  git push -q origin "v$VERSAO"
fi

echo
echo "✓ publicado ($(git rev-parse --short HEAD))"
echo
echo "  Agora, na VPS:"
echo "    cd /opt/petshop && git pull && bash scripts/atualizar-vps.sh $VERSAO"
