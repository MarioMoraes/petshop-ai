#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Roda NA VPS. Dump do banco (formato custom do pg_dump, já comprimido) em
# /opt/petshop/backups e cópia num bucket R2 PRIVADO. Guarda 14 dias no disco; no
# R2 a retenção é uma regra de ciclo de vida do bucket.
#
#   bash scripts/backup-banco.sh
#
# Agendado todo dia às 04:30 pelo timer do systemd `petshop-backup.timer` — depois
# das varreduras de retenção da madrugada (`agent.retention` às 03:50), para o dump
# já sair sem o que elas expurgaram. As unidades estão em docs/deploy-swarm.md.
#
# Nunca use o bucket das mídias (`R2_BUCKET`): o dump tem dados de clientes e merece
# um bucket só dele, com outra regra de retenção e, de preferência, outro token.
#
# O dump NÃO leva a ENCRYPTION_KEK, de propósito. Sem ela o dump restaura e todo campo
# cifrado vira lixo — ela precisa estar guardada noutro lugar, fora deste bucket.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
DIR=${BACKUP_DIR:-backups}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

# No Swarm o container se chama petshop_postgres.1.<id da task>: o nome muda a cada
# reinício, por isso o filtro e não um nome fixo.
PG=$(docker ps -qf "name=${STACK_NAME:-petshop}_postgres" | head -1)
[ -n "$PG" ] || { echo "$(date -u +%FT%TZ) ERRO: container do Postgres não encontrado" >&2; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
file="petshop-$(date -u +%Y%m%dT%H%MZ).dump"
tmp="$DIR/.$file.part"

# Como `postgres`, que ignora o RLS: com app_user o dump sairia vazio de dados de tenant.
docker exec "$PG" pg_dump -U postgres -d petshop -Fc > "$tmp"
# Um dump truncado (container caiu no meio) não passa no pg_restore --list.
docker exec -i "$PG" pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$DIR/$file"
chmod 600 "$DIR/$file"
echo "$(date -u +%FT%TZ) ok $file $(du -h "$DIR/$file" | cut -f1)"

if [ -n "${R2_BACKUP_BUCKET:-}" ]; then
  # aws-cli em container: nada a instalar na VPS.
  docker run --rm -v "$PWD/$DIR:/b:ro" \
    -e AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID:-$R2_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY:-$R2_SECRET_ACCESS_KEY}" \
    -e AWS_DEFAULT_REGION=auto \
    amazon/aws-cli:2.17.0 s3 cp "/b/$file" "s3://$R2_BACKUP_BUCKET/db/$file" \
    --endpoint-url "$R2_ENDPOINT" --only-show-errors
  echo "$(date -u +%FT%TZ) r2 s3://$R2_BACKUP_BUCKET/db/$file"
else
  echo "$(date -u +%FT%TZ) AVISO: R2_BACKUP_BUCKET vazia, backup só no disco da VPS" >&2
fi

find "$DIR" -name 'petshop-*.dump' -mtime "+$KEEP_DAYS" -delete
