#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 2 do deploy — roda NA VPS (Hostinger, Docker Swarm).
#
#   cd /opt/petshop && git pull && bash scripts/atualizar-vps.sh 0.1.0
#
# Serve para o primeiro deploy e para todos os seguintes: `docker stack deploy` é
# idempotente e só mexe no que mudou.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

VERSAO=${1:-}
if [ -z "$VERSAO" ]; then
  echo "uso: bash scripts/atualizar-vps.sh <versao>   (ex.: 0.1.0)" >&2
  echo "     as versões disponíveis são as tags publicadas por publicar-imagens.sh" >&2
  exit 1
fi

ENV_FILE=${ENV_FILE:-.env.production}
STACK=${STACK_NAME:-petshop}
REGISTRY=${REGISTRY:-ghcr.io}
NAMESPACE=${GHCR_NAMESPACE:-mariomoraes}
PREFIXO="$REGISTRY/$NAMESPACE/petshop"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: $ENV_FILE não existe. Copie de .env.production.example e preencha." >&2
  exit 1
fi

# 600 e não 644: o arquivo tem a KEK, a senha do banco e o segredo do Clerk. Num
# servidor com mais de um usuário, 644 é o mesmo que publicá-lo.
PERM=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
if [ "$PERM" != "600" ]; then
  echo "AVISO: $ENV_FILE está com permissão $PERM. Corrigindo para 600."
  chmod 600 "$ENV_FILE"
fi

# ── Conferir a configuração ANTES de tocar em qualquer coisa ──────────────────
# O `${VAR:?}` do stack file já barra o que está vazio, mas só depois de o deploy
# começar, e ele não tem opinião sobre o que está PREENCHIDO ERRADO: um
# `sk_live_...` deixado como está, uma senha de role com caractere que o ALTER ROLE
# não aceita, uma chave de IA em branco que desliga o agente sem avisar ninguém.
echo "→ conferindo $ENV_FILE"
if ! ENV_FILE="$ENV_FILE" bash scripts/conferir-ambiente.sh; then
  echo >&2
  echo "ERRO: a configuração tem erros. Corrija o $ENV_FILE e rode de novo." >&2
  echo "      (para conferir sem fazer deploy: bash scripts/conferir-ambiente.sh --dns)" >&2
  exit 1
fi

# `docker stack deploy` NÃO lê `env_file` nem `--env-file`: ele interpola a partir
# do ambiente do shell, e só. Sem este `set -a` todo `${VAR:?}` do stack file
# aborta o deploy — que é o comportamento desejado, mas pela razão errada.
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

export IMAGE_TAG="$VERSAO"
export STACK_NAME="$STACK"
export BACKEND_IMAGE="$PREFIXO-backend:$VERSAO"
export FRONTEND_IMAGE="$PREFIXO-frontend:$VERSAO"
export MIGRATOR_IMAGE="$PREFIXO-migrator:$VERSAO"
export CADDY_IMAGE="$PREFIXO-caddy:$VERSAO"

# ── O que o leitor do stack REALMENTE vai usar ────────────────────────────────
# Parece paranoia e não é. Em 19/09/2026, migrando de VPS, o interpolador do
# `docker stack deploy` — que é outro, mais antigo que o do `docker compose` —
# quebrou `${BACKEND_IMAGE:?… ex. …/petshop-backend:0.1.0}` no último hífen da
# MENSAGEM e usou "backend:0.1.0" como se fosse um valor padrão. Sem erro nenhum:
# o deploy seguiu, e o sintoma chegou dois minutos depois como "pull access denied"
# numa imagem que ninguém tinha pedido.
#
# A mensagem foi corrigida, mas a classe do problema é "o arquivo resolveu para
# outra coisa e ninguém viu". Conferir custa uma chamada read-only.
echo "→ conferindo o que o stack file resolve"
RESOLVIDO=$(docker stack config -c infra/docker-compose.swarm.yml 2>/dev/null || true)
for IMG in "$BACKEND_IMAGE" "$MIGRATOR_IMAGE" "$FRONTEND_IMAGE" "$CADDY_IMAGE"; do
  if ! printf '%s' "$RESOLVIDO" | grep -q "image: $IMG"; then
    echo "ERRO: o stack file não resolve para $IMG." >&2
    echo "      O que ele resolveu:" >&2
    printf '%s' "$RESOLVIDO" | grep 'image:' | sed 's/^/        /' >&2
    exit 1
  fi
done
echo "  ✓ as quatro imagens conferem"

if ! docker info 2>/dev/null | grep -q 'Swarm: active'; then
  echo "ERRO: este nó não está em swarm. Rode antes: bash scripts/preparar-vps.sh" >&2
  exit 1
fi

# ── Puxar as imagens ANTES do deploy ──────────────────────────────────────────
# `stack deploy` com uma tag inexistente não falha na hora: ele aceita a spec, as
# tasks entram em `Rejected: No such image` e ficam girando. Puxando aqui, um erro
# de digitação na versão para o script antes de qualquer coisa ser tocada.
echo "→ puxando imagens $VERSAO"
for IMG in "$BACKEND_IMAGE" "$MIGRATOR_IMAGE" "$FRONTEND_IMAGE" "$CADDY_IMAGE"; do
  echo "  $IMG"
  docker pull -q "$IMG" >/dev/null
done

# As tasks do migrator que já existiam. Sem esta foto, um redeploy em que a spec do
# migrator não mudou (mesma versão, só um ajuste de env noutro serviço) encontraria
# a task `Complete` da rodada ANTERIOR e o script anunciaria "migração concluída"
# sem que nada tivesse rodado. O que se espera é uma task NOVA, não um estado.
TASKS_ANTES=$(docker service ps -q --no-trunc "${STACK}_migrator" 2>/dev/null || true)

# ── Deploy ────────────────────────────────────────────────────────────────────
# `--with-registry-auth` propaga a credencial do ghcr.io para os nós. Num swarm de
# um nó só ela é dispensável, mas o dia em que um segundo nó entrar é exatamente o
# dia em que ninguém vai lembrar de acrescentá-la.
echo
echo "→ docker stack deploy $STACK"
docker stack deploy \
  --with-registry-auth \
  --resolve-image changed \
  -c infra/docker-compose.swarm.yml \
  "$STACK"

# ── Acompanhar a migração ─────────────────────────────────────────────────────
# É o único passo que pode deixar o sistema num estado pior do que estava. Os
# serviços não sobem antes dela (infra/swarm/aguardar-migracao.sh), então esperar
# aqui é esperar o deploy inteiro.

# Só as tasks que NÃO existiam antes deste deploy, com o estado de cada uma.
tasks_novas() {
  docker service ps --no-trunc --format '{{.ID}} {{.CurrentState}}' "${STACK}_migrator" 2>/dev/null \
    | grep -vFf <(printf '%s\n' "${TASKS_ANTES:-__nenhuma__}") || true
}

echo
echo "→ esperando o migrator"
INICIO=$(date +%s)
FIM=$(( INICIO + 600 ))
FORCADO=false
while :; do
  NOVAS=$(tasks_novas)

  if printf '%s\n' "$NOVAS" | grep -q ' Complete'; then
    echo "  ✓ migração concluída"
    break
  fi

  FALHA=$(printf '%s\n' "$NOVAS" | grep -E ' (Failed|Rejected)' | head -1 || true)
  if [ -n "$FALHA" ]; then
    echo "  ✗ o migrator falhou: $FALHA" >&2
    echo >&2
    docker service logs --tail 40 "${STACK}_migrator" >&2 || true
    echo >&2
    echo "  Os serviços NÃO subiram com o schema errado — o gate de partida os" >&2
    echo "  segura. Corrija a migração e rode este script de novo." >&2
    exit 1
  fi

  # Trinta segundos sem task nova significa que a spec do migrator não mudou (mesma
  # versão de imagem) e o Swarm não vai recriar nada por conta própria. Empurrar é
  # barato: os três passos do migrator são idempotentes, e rodá-los torna o deploy
  # verificado em vez de presumido.
  if [ -z "$NOVAS" ] && [ "$FORCADO" = false ] && [ $(( $(date +%s) - INICIO )) -ge 30 ]; then
    echo "  (spec inalterada; forçando uma passada)"
    docker service update --force --detach "${STACK}_migrator" >/dev/null
    FORCADO=true
  fi

  if [ "$(date +%s)" -ge "$FIM" ]; then
    echo "  ✗ 10 min sem conclusão. Tasks novas: ${NOVAS:-<nenhuma>}" >&2
    docker service logs --tail 40 "${STACK}_migrator" >&2 || true
    exit 1
  fi
  sleep 5
done

# ── Conferir ──────────────────────────────────────────────────────────────────
echo
echo "→ convergindo os serviços (o gate de migração já liberou; leva ~1 min)"
sleep 20
docker stack services "$STACK"

echo
echo "  migrator em 0/1 é o esperado: é uma tarefa de uma passada só."
echo
echo "  Conferir de fora:"
echo "    curl -sI https://app.${APP_DOMAIN}"
echo "  Acompanhar um serviço:"
echo "    docker service logs -f ${STACK}_api-gateway"
echo "  Voltar para a versão anterior:"
echo "    bash scripts/atualizar-vps.sh <versao-anterior>"
echo "    (vale para o código; migração o Prisma não desfaz — veja docs/deploy-swarm.md)"
