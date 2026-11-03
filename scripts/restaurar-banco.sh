#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Roda NA VPS. Restaura um dump do backup-banco.sh por cima do banco atual.
# APAGA os dados de agora — rode antes um backup-banco.sh do estado atual.
#
#   bash scripts/restaurar-banco.sh backups/petshop-20261104T0730Z.dump
#
# Para o backend (api-gateway) durante a restauração e o religa no fim: com ele de pé,
# os jobs e os webhooks escreveriam no meio do --clean. O frontend fica no ar e mostra
# erro por um ou dois minutos.
#
# Pressupõe a MESMA ENCRYPTION_KEK no .env.production: os campos cifrados do dump só
# abrem com a chave que os cifrou.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
dump=${1:?informe o arquivo .dump}
[ -f "$dump" ] || { echo "ERRO: $dump não existe" >&2; exit 1; }
STACK=${STACK_NAME:-petshop}

PG=$(docker ps -qf "name=${STACK}_postgres" | head -1)
[ -n "$PG" ] || { echo "ERRO: container do Postgres não encontrado" >&2; exit 1; }

docker exec -i "$PG" pg_restore --list < "$dump" > /dev/null || {
  echo "ERRO: $dump não é um dump válido" >&2; exit 1; }

read -r -p "Isto substitui o banco de produção por $dump. Digite RESTAURAR: " ok
[ "$ok" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }

docker service scale "${STACK}_api-gateway=0"
trap 'docker service scale "${STACK}_api-gateway=1"' EXIT

# --clean recria os objetos (políticas de RLS, gatilhos e regras inclusive), numa
# transação só: se falhar no meio, o banco fica como estava.
docker exec -i "$PG" pg_restore -U postgres -d petshop --clean --if-exists --single-transaction < "$dump"
echo "Restaurado. O backend volta em seguida; confira com: docker stack services $STACK"
