#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Roda NA VPS. Prova que o backup restaura — SEM tocar no banco de produção.
#
#   bash scripts/testar-restauracao.sh            # baixa o dump mais novo do R2
#   bash scripts/testar-restauracao.sh backups/petshop-20261104T0730Z.dump
#
# Sem argumento, baixa do bucket R2 o dump mais recente: é a cópia fora da VPS que
# importa no dia em que a VPS some. Restaura num banco descartável
# (`petshop_restore_test`, no mesmo Postgres), compara a contagem de linhas de cada
# tabela com a produção e a quantidade de políticas de RLS, e apaga o banco de teste.
#
# A produção segue escrevendo depois do dump, então diferença pequena em tabela de
# movimento (messages, audit_logs…) é esperada; tabela inteira vazia não é.
# O que este teste NÃO prova: que a ENCRYPTION_KEK guardada fora daqui é a certa.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a
TEST_DB=petshop_restore_test

PG=$(docker ps -qf "name=${STACK_NAME:-petshop}_postgres" | head -1)
[ -n "$PG" ] || { echo "ERRO: container do Postgres não encontrado" >&2; exit 1; }

work=$(mktemp -d)
cleanup() {
  docker exec "$PG" psql -U postgres -qc "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

aws() {
  docker run --rm -v "$work:/w" \
    -e AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID:-$R2_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY:-$R2_SECRET_ACCESS_KEY}" \
    -e AWS_DEFAULT_REGION=auto \
    amazon/aws-cli:2.17.0 "$@" --endpoint-url "$R2_ENDPOINT"
}

if [ $# -ge 1 ]; then
  dump=$1
  [ -f "$dump" ] || { echo "ERRO: $dump não existe" >&2; exit 1; }
  echo "1/4 dump local: $dump"
else
  : "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET vazia — passe um arquivo local}"
  latest=$(aws s3 ls "s3://$R2_BACKUP_BUCKET/db/" | awk '{print $4}' | grep '^petshop-.*\.dump$' | sort | tail -1)
  [ -n "$latest" ] || { echo "ERRO: nenhum dump no bucket" >&2; exit 1; }
  echo "1/4 baixando do R2: $latest"
  aws s3 cp "s3://$R2_BACKUP_BUCKET/db/$latest" "/w/$latest" --only-show-errors
  dump="$work/$latest"
fi
echo "    tamanho: $(du -h "$dump" | cut -f1)"

echo "2/4 restaurando em $TEST_DB (a produção não é tocada)"
docker exec "$PG" psql -U postgres -qc "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null
docker exec "$PG" psql -U postgres -qc "CREATE DATABASE $TEST_DB" >/dev/null
start=$(date +%s)
docker exec -i "$PG" pg_restore -U postgres -d "$TEST_DB" --no-owner --single-transaction --exit-on-error < "$dump"
echo "    restaurado em $(( $(date +%s) - start ))s"

# Contagem exata de cada tabela de public, como o postgres (ignora o RLS).
COUNT_SQL="select c.relname || '|' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p') order by 1"

echo "3/4 comparando com a produção"
docker exec "$PG" psql -U postgres -d petshop -Atc "$COUNT_SQL" | LC_ALL=C sort > "$work/prod.txt"
docker exec "$PG" psql -U postgres -d "$TEST_DB" -Atc "$COUNT_SQL" | LC_ALL=C sort > "$work/rest.txt"

printf '    %-40s %10s %10s\n' tabela produção backup
LC_ALL=C join -t'|' -a1 -e AUSENTE -o 0,1.2,2.2 "$work/prod.txt" "$work/rest.txt" | while IFS='|' read -r t p r; do
  marca=""
  if [ "$r" = AUSENTE ]; then marca="  ← FALTA NO BACKUP"
  elif [ "$p" -ge 10 ] && [ "$r" -eq 0 ]; then marca="  ← VAZIA NO BACKUP"
  elif [ "$p" -gt 0 ] && [ "$r" -eq 0 ]; then marca="  (vazia no backup: poucas linhas, devem ser posteriores ao dump)"
  elif [ "$p" != "$r" ]; then marca="  (mudou desde o dump)"
  fi
  if [ -n "$marca" ]; then printf '    %-40s %10s %10s%s\n' "$t" "$p" "$r" "$marca"; fi
done
tabelas=$(wc -l < "$work/prod.txt")
graves=$(LC_ALL=C join -t'|' -a1 -e AUSENTE -o 0,1.2,2.2 "$work/prod.txt" "$work/rest.txt" \
  | awk -F'|' '$3=="AUSENTE" || ($2>=10 && $3==0)' | wc -l)

pol() { docker exec "$PG" psql -U postgres -d "$1" -Atc "select count(*) from pg_policies where schemaname='public'"; }
pp=$(pol petshop); pr=$(pol "$TEST_DB")
mig=$(docker exec "$PG" psql -U postgres -d "$TEST_DB" -Atc "select count(*) from _prisma_migrations where finished_at is not null")
keys=$(docker exec "$PG" psql -U postgres -d "$TEST_DB" -Atc "select count(*) from data_keys" 2>/dev/null || echo "?")

echo "4/4 resumo"
echo "    tabelas: $tabelas · com problema grave: $graves"
echo "    políticas de RLS: produção $pp · backup $pr"
echo "    migrations no backup: $mig · chaves de tenant (data_keys): $keys"
if [ "$graves" -eq 0 ] && [ "$pp" = "$pr" ]; then
  echo "OK: o backup restaura inteiro."
else
  echo "FALHOU: veja as linhas marcadas acima." >&2; exit 1
fi
