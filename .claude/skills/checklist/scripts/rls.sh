#!/usr/bin/env bash
# Item (1) do checklist: tabelas do schema Prisma × RLS nas migrations.
#
# Para cada tabela (@@map do schema.prisma) diz se alguma migration faz
# ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY e CREATE POLICY nela.
# Só imprime as que falham em alguma das três; a triagem (tabela global de
# propósito × esquecimento) é de quem lê.
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel)}"
SCHEMA="$ROOT/packages/db/prisma/schema.prisma"
MIGR="$ROOT/packages/db/prisma/migrations"

# Normaliza: tudo numa linha só por instrução, minúsculas, sem aspas.
SQL=$(cat "$MIGR"/*/migration.sql | tr '\n' ' ' | tr ';' '\n' | tr 'A-Z' 'a-z' | tr -d '"')

printf '%-40s %-7s %-7s %-7s %s\n' TABELA ENABLE FORCE POLICY 'TEM tenant_id?'
falhas=0
while IFS=: read -r linha tabela; do
  t=$(echo "$tabela" | tr 'A-Z' 'a-z')
  en=$(grep -Eq "alter table (public\.)?$t enable row level security" <<<"$SQL" && echo sim || echo NAO)
  fo=$(grep -Eq "alter table (public\.)?$t force row level security" <<<"$SQL" && echo sim || echo NAO)
  po=$(grep -Eq "create policy [a-z0-9_]+ on (public\.)?$t( |$)" <<<"$SQL" && echo sim || echo NAO)
  # tenant_id no bloco do model que termina nesta linha de @@map
  inicio=$(awk -v l="$linha" 'NR<=l && /^model /{m=NR} END{print m}' "$SCHEMA")
  tid=$(sed -n "${inicio},${linha}p" "$SCHEMA" | grep -Eq 'tenantId|tenant_id' && echo sim || echo nao)
  if [[ $en == NAO || $fo == NAO || $po == NAO ]]; then
    printf '%-40s %-7s %-7s %-7s %s   (schema.prisma:%s)\n' "$t" "$en" "$fo" "$po" "$tid" "$linha"
    falhas=$((falhas+1))
  fi
done < <(grep -n '@@map("' "$SCHEMA" | sed -E 's/^([0-9]+):.*@@map\("([^"]+)"\).*/\1:\2/')

echo
echo "$falhas tabela(s) com alguma das três proteções ausente."
