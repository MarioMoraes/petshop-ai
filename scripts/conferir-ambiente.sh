#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 0.5 — confere o `.env.production` ANTES de qualquer imagem subir.
#
#   bash scripts/conferir-ambiente.sh            # confere .env.production
#   bash scripts/conferir-ambiente.sh --dns      # confere também os registros de DNS
#
# Roda tanto no Mac quanto na VPS, e não toca em nada: só lê.
#
# ── Por que existe ────────────────────────────────────────────────────────────
# Erro de configuração neste projeto quase nunca aparece como erro. Aparece como
# um serviço verde servindo coisa errada, e as três formas são:
#
#   1. Variável OBRIGATÓRIA em branco. O `${VAR:?}` do compose aborta o deploy —
#      esta é a forma boa, e mesmo assim é melhor descobrir aqui do que no meio de
#      um `stack deploy` já começado.
#   2. Variável OPCIONAL em branco. Nada falha: um recurso inteiro fica desligado
#      em silêncio (o agente de IA, o e-mail, o webhook). É a forma cara.
#   3. Placeholder do arquivo de exemplo deixado como está — `CHANGE_ME`,
#      `sk_live_...`, `<account-id>`. Passa por qualquer validação de "está
#      preenchido?" e só o primeiro cliente real descobre.
#
# A lista de variáveis abaixo é conferida contra o que os composes de fato leem
# (`${VAR}`), então uma variável nova num compose sem entrada aqui é reportada.
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${ENV_FILE:-.env.production}
CONFERIR_DNS=false
[ "${1:-}" = "--dns" ] && CONFERIR_DNS=true

erros=0
avisos=0

vermelho() { printf '\033[31m%s\033[0m\n' "$*"; }
amarelo()  { printf '\033[33m%s\033[0m\n' "$*"; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
titulo()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

erro()  { vermelho "  ✗ $*"; erros=$((erros + 1)); }
aviso() { amarelo  "  ! $*"; avisos=$((avisos + 1)); }
ok()    { verde    "  ✓ $*"; }

if [ ! -f "$ENV_FILE" ]; then
  vermelho "ERRO: $ENV_FILE não existe."
  echo "       cp .env.production.example $ENV_FILE && chmod 600 $ENV_FILE"
  exit 1
fi

# `set -a` para que as variáveis fiquem no ambiente, exatamente como o
# atualizar-vps.sh as carrega — conferir o arquivo de outra forma seria conferir
# outra coisa.
# `./` só quando o caminho é relativo: com um caminho absoluto o prefixo produz
# `.//tmp/...`, o `.` falha, e o script segue conferindo um ambiente VAZIO —
# reprovando tudo e escondendo o que o arquivo de fato diz.
case "$ENV_FILE" in /*) CAMINHO=$ENV_FILE ;; *) CAMINHO=./$ENV_FILE ;; esac
set -a
# shellcheck disable=SC1090
. "$CAMINHO"
set +a

# Valor que "está preenchido" mas não vale nada. Cada um destes já foi deixado
# para trás numa instalação real de algum projeto; é o modo de falha mais chato
# porque toda validação ingênua o aprova.
eh_placeholder() {
  # `<...>` com um @ dentro NÃO é placeholder: é a forma legítima de um remetente
  # ("PetShop AI <contato@dominio>"). Só `<account-id>` e parentes é que são.
  case "$1" in
    *'<'*@*'>'*) return 1 ;;
  esac
  case "$1" in
    ''|*CHANGE_ME*|*'...'*|*'<'*'>'*|voce@*|*example.com*) return 0 ;;
    *) return 1 ;;
  esac
}

# obrigatoria NOME "para que serve"
obrigatoria() {
  local nome=$1 desc=$2 valor=${!1:-}
  if [ -z "$valor" ]; then
    erro "$nome está vazia — $desc"
  elif eh_placeholder "$valor"; then
    erro "$nome ainda é o placeholder do exemplo ('$valor') — $desc"
  else
    ok "$nome"
  fi
}

# opcional NOME "o que acontece se ficar em branco"
opcional() {
  local nome=$1 consequencia=$2 valor=${!1:-}
  if [ -z "$valor" ]; then
    aviso "$nome em branco → $consequencia"
  elif eh_placeholder "$valor"; then
    erro "$nome ainda é o placeholder do exemplo ('$valor')"
  else
    ok "$nome"
  fi
}

# ── Qual alvo de deploy? ──────────────────────────────────────────────────────
# Duas bordas possíveis, e elas pedem coisas diferentes:
#
#   • **Caddy nosso** (docker-compose.swarm.yml / .prod.yml) — emite o wildcard
#     por DNS-01 e por isso EXIGE o token da Cloudflare.
#   • **Traefik do EasyPanel** (docker-compose.easypanel.yml) — as portas 80/443
#     já têm dono; quem emite certificado é ele, por HTTP-01, e cada host precisa
#     estar nomeado em PETSHOP_HOSTS. O token da Cloudflare não é usado.
#
# `PETSHOP_HOSTS` só existe no segundo caminho, então ela é o sinal.
if [ -n "${PETSHOP_HOSTS:-}" ]; then ALVO=easypanel; else ALVO=caddy; fi

echo "Conferindo $ENV_FILE  (borda: $ALVO)"

# ── Permissão ─────────────────────────────────────────────────────────────────
PERM=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
titulo "Arquivo"
if [ "$PERM" = "600" ]; then ok "permissão 600"; else aviso "permissão $PERM (o esperado é 600: o arquivo tem a KEK e a senha do banco)"; fi

# ── Domínio e TLS ─────────────────────────────────────────────────────────────
titulo "Domínio e TLS"
obrigatoria APP_DOMAIN "sem ele TODO host cai no Admin e nem o site nem o Portal respondem"
if [ "$ALVO" = caddy ]; then
  obrigatoria ACME_EMAIL "é para onde a Let's Encrypt avisa que o certificado expira"
  obrigatoria CLOUDFLARE_API_TOKEN "assina o desafio DNS-01; sem ele não sai certificado wildcard e nenhum petshop abre"
else
  ok "borda é o Traefik do EasyPanel — CLOUDFLARE_API_TOKEN e ACME_EMAIL não são usados"
  obrigatoria PETSHOP_HOSTS "cada host precisa estar nomeado aqui; sem wildcard, é o que faz o certificado existir"
  # A linha CRUA do arquivo, e não a variável já carregada. O escape só é problema
  # para o `docker compose --env-file`, que lê o texto literalmente; o bash que
  # carregou este script já consumiu a barra invertida, então pela variável o
  # defeito é invisível. Foi assim que ele passou despercebido na primeira vez.
  CRUA=$(grep -m1 '^PETSHOP_HOSTS=' "$CAMINHO" || true)
  case "$CRUA" in
    *'\`'*) erro 'PETSHOP_HOSTS tem crase escapada (\`). Use ASPAS SIMPLES: o compose entrega a barra invertida ao Traefik e a regra é recusada' ;;
  esac
  case "${PETSHOP_HOSTS:-}" in
    *'`'*) ;;
    *)     erro "PETSHOP_HOSTS não parece regra do Traefik — esperado algo como: Host(\`app.dominio\`)" ;;
  esac
  case "${PETSHOP_HOSTS:-}" in
    *"app.${APP_DOMAIN:-}"*) ;;
    *) aviso "PETSHOP_HOSTS não inclui app.${APP_DOMAIN:-} — é o host do Admin; sem ele ninguém entra" ;;
  esac
fi

case "${APP_DOMAIN:-}" in
  http*|*/*) erro "APP_DOMAIN deve ser só o domínio, sem esquema e sem barra (está '$APP_DOMAIN')" ;;
  .*)        erro "APP_DOMAIN não leva ponto inicial (está '$APP_DOMAIN')" ;;
esac

# ── Senhas ────────────────────────────────────────────────────────────────────
titulo "Senhas de infraestrutura"
for v in POSTGRES_PASSWORD APP_USER_PASSWORD APP_MAINTENANCE_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD; do
  obrigatoria "$v" "a stack não sobe sem ela"
done
# As duas roles entram num ALTER ROLE que não aceita parâmetro ligado, então o
# conjunto de caracteres é restrito de verdade (prisma/set-role-passwords.ts).
for v in APP_USER_PASSWORD APP_MAINTENANCE_PASSWORD; do
  valor=${!v:-}
  if [ -n "$valor" ]; then
    if [ ${#valor} -lt 16 ]; then
      erro "$v tem ${#valor} caracteres; o mínimo é 16"
    fi
    if printf '%s' "$valor" | grep -q '[^A-Za-z0-9._~-]'; then
      erro "$v tem caractere fora de [A-Za-z0-9._~-] — o ALTER ROLE do set-role-passwords.ts a interpola literalmente"
    fi
  fi
done

# ── Criptografia ──────────────────────────────────────────────────────────────
titulo "Criptografia de PII"
obrigatoria ENCRYPTION_KEK "é a raiz de tudo que é cifrado no banco"
obrigatoria EMAIL_HASH_PEPPER "sem ele as buscas por CPF/telefone/e-mail não acham nada"
obrigatoria INTERNAL_SERVICE_SECRET "exigido na subida (mínimo 16 caracteres)"
if [ -n "${INTERNAL_SERVICE_SECRET:-}" ] && [ ${#INTERNAL_SERVICE_SECRET} -lt 16 ]; then
  erro "INTERNAL_SERVICE_SECRET tem ${#INTERNAL_SERVICE_SECRET} caracteres; o schema exige 16"
fi

# ── O par que precisa bater ───────────────────────────────────────────────────
titulo "Revalidação do site (a mesma variável nos dois containers)"
obrigatoria SITE_REVALIDATE_SECRET "backend e frontend precisam do MESMO valor, senão o site serve horário velho"

# ── Clerk ─────────────────────────────────────────────────────────────────────
titulo "Clerk"
obrigatoria CLERK_SECRET_KEY "sem ela ninguém entra"
obrigatoria NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY "assada na imagem do frontend em tempo de build"
case "${CLERK_SECRET_KEY:-}" in sk_live_*) ;; sk_test_*) aviso "CLERK_SECRET_KEY é de TESTE (sk_test_) — as contas criadas irão para a instância errada" ;; esac
case "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}" in pk_live_*) ;; pk_test_*) aviso "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY é de TESTE (pk_test_) — e ela é assada na IMAGEM: trocá-la exige republicar o frontend" ;; esac
opcional CLERK_WEBHOOK_SECRET "a rota /internal/v1/clerk/webhook recusa tudo com 401 e o MOD-IDENT-03 não sincroniza usuário"

# ── Mídia ─────────────────────────────────────────────────────────────────────
titulo "Storage de mídia (R2)"
opcional R2_ENDPOINT "foto de pet e galeria do site não sobem"
opcional R2_ACCESS_KEY_ID "idem"
opcional R2_SECRET_ACCESS_KEY "idem"

# ── E-mail ────────────────────────────────────────────────────────────────────
titulo "E-mail (Resend)"
opcional RESEND_API_KEY "todo e-mail vira log: a mensagem consta como enviada com provider='log' e ninguém recebe"
opcional MAIL_FROM "o Resend recusa o envio sem remetente de domínio verificado"
opcional RESEND_WEBHOOK_SECRET "a rota /internal/v1/email/webhook recusa tudo com 401 e bounce não volta"

# ── WhatsApp ──────────────────────────────────────────────────────────────────
titulo "Canal WhatsApp (Evolution)"
obrigatoria EVOLUTION_API_KEY "o container da Evolution não sobe sem ela (é \${EVOLUTION_API_KEY:?} no compose)"

# ── Agente de IA ──────────────────────────────────────────────────────────────
titulo "Agente de atendimento (MOD-AI)"
case "${AI_PROVIDER:-anthropic}" in
  anthropic)
    ok "AI_PROVIDER=anthropic"
    opcional ANTHROPIC_API_KEY "o agente se comporta como DESLIGADO — a tela deixa ligar o atendimento automático, o interruptor acende e nenhuma mensagem é respondida"
    ;;
  gemini)
    aviso "AI_PROVIDER=gemini — o provedor de desenvolvimento (free tier); produção é 'anthropic'"
    opcional GEMINI_API_KEY "o agente se comporta como desligado"
    ;;
  *) erro "AI_PROVIDER='${AI_PROVIDER}' não existe; use 'anthropic' ou 'gemini'" ;;
esac

# ── Plataforma ────────────────────────────────────────────────────────────────
titulo "Console da plataforma (MOD-ADMIN)"
opcional PLATFORM_ADMIN_BOOTSTRAP_EMAIL "/plataforma fica inalcançável até alguém semear platform_admins por psql (é um estado válido, mas você não entra no console)"
if [ -n "${PLATFORM_ADMIN_BOOTSTRAP_EMAIL:-}" ]; then
  case "$PLATFORM_ADMIN_BOOTSTRAP_EMAIL" in
    *@*.*) ;;
    *) erro "PLATFORM_ADMIN_BOOTSTRAP_EMAIL não parece um e-mail ('$PLATFORM_ADMIN_BOOTSTRAP_EMAIL')" ;;
  esac
fi

# ── Registry ──────────────────────────────────────────────────────────────────
titulo "Registry"
obrigatoria REGISTRY "de onde a VPS puxa as imagens"
obrigatoria GHCR_NAMESPACE "compõe o nome da imagem"

# ── Toda variável que os composes leem tem entrada aqui? ──────────────────────
# Guarda contra esta lista envelhecer: se alguém acrescentar `${NOVA_COISA}` num
# compose e esquecer de documentá-la, ela aparece aqui em vez de virar uma
# string vazia silenciosa dentro do container.
titulo "Cobertura (variáveis dos composes sem entrada no exemplo)"
declare -a nao_cobertas=()
exportadas_pelo_script=" BACKEND_IMAGE FRONTEND_IMAGE MIGRATOR_IMAGE CADDY_IMAGE IMAGE_TAG STACK_NAME "
for nome in $(grep -ohE '\$\{[A-Z_][A-Z_0-9]*' infra/docker-compose.swarm.yml infra/docker-compose.prod.yml infra/docker-compose.easypanel.yml \
                | sed 's/\${//' | sort -u); do
  case "$exportadas_pelo_script" in *" $nome "*) continue ;; esac
  grep -qE "^${nome}=" .env.production.example || nao_cobertas+=("$nome")
done
if [ ${#nao_cobertas[@]} -eq 0 ]; then
  ok "toda variável dos composes está no .env.production.example"
else
  for n in "${nao_cobertas[@]}"; do
    erro "$n é lida por um compose e não existe no .env.production.example"
  done
fi

# ── DNS ───────────────────────────────────────────────────────────────────────
if [ "$CONFERIR_DNS" = true ]; then
  titulo "DNS (--dns)"
  if ! command -v dig >/dev/null 2>&1; then
    aviso "dig não encontrado; pulei a conferência de DNS"
  else
    # O wildcard é conferido por um nome que não existe: se `*.dominio` estiver
    # publicado, qualquer rótulo responde. É a única forma de testar um wildcard.
    apex=$(dig +short A "${APP_DOMAIN}" | tail -1)
    curinga=$(dig +short A "conferencia-deploy.${APP_DOMAIN}" | tail -1)
    [ -n "$apex" ]    && ok "A ${APP_DOMAIN} → $apex"          || erro "A ${APP_DOMAIN} não resolve"
    [ -n "$curinga" ] && ok "A *.${APP_DOMAIN} → $curinga"     || erro "A *.${APP_DOMAIN} não resolve — sem ele nenhum host de tenant abre, e o slug vai impresso em QR code"
    if [ -n "$apex" ] && [ -n "$curinga" ] && [ "$apex" != "$curinga" ]; then
      aviso "o ápice e o wildcard apontam para IPs diferentes ($apex vs $curinga)"
    fi
    # Nuvem laranja: a Cloudflare responde com IP dela, não com o da VPS. O TLS
    # passaria a ser terminado lá, e o wildcard de terceiro nível que o Universal
    # SSL não cobre daria erro de certificado em TODO host de tenant.
    for ip in $apex $curinga; do
      case "$ip" in
        104.1[6-9].*|104.2[0-7].*|172.6[4-9].*|172.7[0-1].*|173.245.*|188.114.*|190.93.*|197.234.*|198.41.*|162.15[89].*|141.101.*|108.162.*|103.21.24*|103.22.20*|103.31.4*)
          erro "$ip é da Cloudflare: o registro está em proxy (nuvem laranja). Precisa ser DNS-only (cinza) — quem termina o TLS é o Caddy da VPS, e o Universal SSL não cobre *.${APP_DOMAIN}" ;;
      esac
    done
  fi
else
  titulo "DNS"
  echo "  (pulado — rode com --dns para conferir os registros)"
fi

# ── Veredito ──────────────────────────────────────────────────────────────────
echo
if [ "$erros" -gt 0 ]; then
  vermelho "══ $erros erro(s) e $avisos aviso(s). Corrija os erros antes de publicar as imagens."
  exit 1
elif [ "$avisos" -gt 0 ]; then
  amarelo "══ 0 erros, $avisos aviso(s)."
  echo "   Aviso não impede o deploy: cada um é um recurso que vai ficar desligado."
  echo "   Se todos forem intencionais, siga."
  exit 0
else
  verde "══ tudo conferido."
  exit 0
fi
