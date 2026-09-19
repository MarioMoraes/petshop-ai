#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Gate de partida dos serviços de backend em Docker Swarm.
#
#   command: ["/app/infra/swarm/aguardar-migracao.sh", "node", "backend/.../server.js"]
#
# ── Por que este arquivo existe ────────────────────────────────────────────────
# O `docker-compose.prod.yml` garante a ordem com
# `depends_on: {migrator: {condition: service_completed_successfully}}`.
# **`docker stack deploy` ignora `depends_on` inteiro** — não parcialmente, não com
# aviso: ignora. Sem substituto, num banco novo os dez serviços sobem antes de a
# role `app_user` sequer existir.
#
# Isso não os derruba, e é justamente o que torna a falha traiçoeira: o Prisma
# conecta preguiçosamente e o `/health` responde `{status:"ok"}` sem tocar no banco.
# O Swarm veria dez serviços saudáveis servindo 500 em toda requisição.
#
# ── O que ele espera, exatamente ──────────────────────────────────────────────
# Não "o Postgres respondeu": espera que **as migrações desta imagem** estejam
# aplicadas. A imagem carrega `packages/db/prisma/migrations/`, então ela sabe
# quantas são — e compara com o que o banco confirma em `_prisma_migrations`.
#
# Uma consulta responde as três perguntas de uma vez: o Postgres aceita conexão? a
# role `app_user` existe com esta senha? o schema chegou onde este código espera?
# `app_user` consegue ler `_prisma_migrations` porque o `GRANT ... ON ALL TABLES`
# da migration de RLS a alcança (ela já existia quando aquele GRANT rodou).
#
# ── A consequência de acertar isto ────────────────────────────────────────────
# Com `update_config.order: start-first`, o container ANTIGO continua atendendo
# enquanto o novo espera aqui. A migração acontece no meio, sem janela de erro.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

MIGRACOES_DIR=${MIGRACOES_DIR:-/app/packages/db/prisma/migrations}
# Teto, não paciência: 10 min cobre `migrate deploy` + seed com folga. Passar disso
# é problema, e um serviço que morre aparece no `docker service ps`; um que espera
# para sempre fica invisível.
TIMEOUT_S=${AGUARDAR_MIGRACAO_TIMEOUT_S:-600}
INTERVALO_S=${AGUARDAR_MIGRACAO_INTERVALO_S:-3}

if [ -z "${DATABASE_URL:-}" ]; then
  echo "aguardar-migracao: DATABASE_URL não definida" >&2
  exit 1
fi

# A `DATABASE_URL` sem a query string, porque `?schema=public` é parâmetro do
# **Prisma** e o libpq — que é quem o `psql` usa — recusa a URL inteira ao ver um
# parâmetro que não conhece:
#
#     psql: error: invalid URI query parameter: "schema"
#
# É o mesmo `PG_URL` que o CMD do migrator já derivava (`infra/Dockerfile`), e
# nasceu do mesmo jeito: aqui o erro ia para /dev/null junto com o ruído esperado
# da partida, e a recusa ficava idêntica a "o banco ainda não está pronto" — o
# gate esperava calado até o healthcheck matar o container com 137, sem uma linha
# de log dizendo por quê. Quem lê `unhealthy container` procura lentidão.
PG_URL=${DATABASE_URL%%\?*}

# Quantas migrações esta imagem traz. `-maxdepth 1 -mindepth 1 -type d` e não `ls`:
# `migrations/` também guarda `migration_lock.toml` e um README.
ESPERADAS=$(find "$MIGRACOES_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [ "$ESPERADAS" = "0" ]; then
  echo "aguardar-migracao: nenhuma migração encontrada em $MIGRACOES_DIR" >&2
  exit 1
fi

echo "aguardar-migracao: esperando $ESPERADAS migrações no banco…"

ERRO=$(mktemp)
trap 'rm -f "$ERRO"' EXIT

# Depois de quantas tentativas o erro deixa de ser ruído de partida e vira
# notícia. As primeiras erram por motivo esperado — "role app_user does not
# exist", "relation _prisma_migrations does not exist" —, e repetir isso a cada
# 3s só enche o log; um erro que dura mais de meio minuto é outra coisa.
PACIENCIA=10

INICIO=$(date +%s)
TENTATIVA=0
while :; do
  # O `|| true` impede que o `set -e` mate o processo por causa de uma recusa
  # esperada; o stderr vai para um arquivo em vez de /dev/null, para que o laço
  # possa mostrá-lo quando a recusa deixar de ser esperada.
  TENTATIVA=$((TENTATIVA + 1))
  APLICADAS=$(psql "$PG_URL" -tAc \
    "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null" \
    2>"$ERRO" || true)

  if [ -n "$APLICADAS" ] && [ "$APLICADAS" -ge "$ESPERADAS" ] 2>/dev/null; then
    echo "aguardar-migracao: $APLICADAS/$ESPERADAS aplicadas — subindo"
    break
  fi

  if [ "$TENTATIVA" -ge "$PACIENCIA" ] && [ $((TENTATIVA % PACIENCIA)) -eq 0 ]; then
    MOTIVO=$(tail -n 1 "$ERRO" || true)
    echo "aguardar-migracao: ${APLICADAS:-0}/$ESPERADAS — ${MOTIVO:-o banco não respondeu}" >&2
  fi

  DECORRIDO=$(( $(date +%s) - INICIO ))
  if [ "$DECORRIDO" -ge "$TIMEOUT_S" ]; then
    echo "aguardar-migracao: ${TIMEOUT_S}s sem o schema esperado (${APLICADAS:-0}/$ESPERADAS)." >&2
    tail -n 1 "$ERRO" >&2 || true
    echo "                   Veja: docker service logs ${STACK_NAME:-petshop}_migrator" >&2
    exit 1
  fi

  sleep "$INTERVALO_S"
done

# `exec` e não uma chamada comum: o processo do Node PRECISA virar o PID 1 do
# container. Sem isso o SIGTERM do `docker service update` chegaria neste shell, que
# não o repassa — o Fastify nunca correria o `shutdown()` e o Swarm mataria o
# container no fim do grace period, no meio de requisições em curso.
exec "$@"
