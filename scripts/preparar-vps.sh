#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 0 — uma vez só, numa VPS Hostinger recém-criada (Ubuntu 22.04/24.04).
#
#   ssh root@<ip>
#   apt-get update && apt-get install -y git
#   git clone https://github.com/MarioMoraes/petshop-ai.git /opt/petshop
#   cd /opt/petshop && bash scripts/preparar-vps.sh
#
# Faz: Docker, swarm, firewall, o diretório do stack. NÃO faz: preencher o
# `.env.production` nem apontar o DNS — as duas coisas que só você pode fazer.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" != "0" ]; then
  echo "ERRO: rode como root (ou com sudo)." >&2
  exit 1
fi

# ── 1. Docker ─────────────────────────────────────────────────────────────────
# O repositório oficial, não o `docker.io` do Ubuntu: o do Ubuntu costuma estar
# uma versão maior atrás, e o Compose v2 (que o `stack deploy` usa para ler o
# arquivo) não vem junto.
if ! command -v docker >/dev/null 2>&1; then
  echo "→ instalando Docker"
  curl -fsSL https://get.docker.com | sh
else
  echo "→ Docker já instalado ($(docker --version))"
fi

# ── 2. Swarm ──────────────────────────────────────────────────────────────────
if docker info 2>/dev/null | grep -q 'Swarm: active'; then
  echo "→ swarm já ativo"
else
  # `--advertise-addr` explícito: numa VPS com mais de uma interface (a pública e
  # a da rede privada da Hostinger) o `swarm init` recusa a inicialização pedindo
  # justamente isto.
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo "→ docker swarm init --advertise-addr $IP"
  docker swarm init --advertise-addr "$IP"
fi

# ── 3. Firewall ───────────────────────────────────────────────────────────────
# 80 e 443 porque é o Caddy quem atende. 22 para não se trancar do lado de fora.
#
# NADA de 2377/7946/4789 (as portas do swarm): num nó só elas não são usadas de
# fora, e abertas seriam controle total do cluster exposto à internet — o
# `docker swarm join` não pede senha, pede um token.
if command -v ufw >/dev/null 2>&1; then
  echo "→ firewall (ufw)"
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw allow 443/udp  >/dev/null   # HTTP/3
  ufw --force enable >/dev/null
  ufw status numbered
else
  echo "→ ufw não encontrado; libere 22, 80 e 443 (tcp e udp) no painel da Hostinger"
fi

# ── 4. Login no ghcr.io ───────────────────────────────────────────────────────
# As imagens são privadas por padrão. O token é um PAT clássico do GitHub com o
# escopo `read:packages` — só leitura, e só de pacotes: se vazar da VPS, o
# estrago para no que já está publicado.
if [ -f ~/.docker/config.json ] && grep -q 'ghcr.io' ~/.docker/config.json 2>/dev/null; then
  echo "→ ghcr.io já autenticado"
else
  echo
  echo "→ falta autenticar no ghcr.io. Rode:"
  echo "    echo <SEU_PAT_read:packages> | docker login ghcr.io -u <seu-usuario> --password-stdin"
fi

# ── 5. .env.production ────────────────────────────────────────────────────────
if [ ! -f .env.production ]; then
  cp .env.production.example .env.production
  chmod 600 .env.production
  echo
  echo "→ .env.production criado a partir do exemplo. PREENCHA antes de seguir."
else
  chmod 600 .env.production
  echo "→ .env.production já existe (permissão ajustada para 600)"
fi

cat <<'FIM'

─────────────────────────────────────────────────────────────────────────────
Falta você fazer, nesta ordem:

1. DNS na Cloudflare, os DOIS registros, em DNS-only (nuvem cinza):
     A  petshop.officestecnologia.com.br    → IP desta VPS
     A  *.petshop.officestecnologia.com.br  → IP desta VPS

   Cinza, não laranja: quem termina o TLS é o Caddy desta máquina, com um
   certificado wildcard próprio. O Universal SSL da Cloudflare não cobre um
   wildcard nesse nível, e pelo proxy laranja todo subdomínio de tenant daria
   erro de certificado.

2. Token da Cloudflare com Zone:DNS:Edit RESTRITO a essa zona (não a Global
   API Key). É ele que assina o desafio DNS-01 — sem DNS-01 não sai wildcard,
   e sem wildcard nenhum petshop abre.

3. Preencher .env.production. Gere cada segredo:
     openssl rand -base64 32 | tr -d '/+=' | head -c 40      # senhas de role
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

   A ENCRYPTION_KEK é a raiz de tudo que é cifrado no banco. Perdê-la é perder
   o PII de todos os tenants — o backup não salva, porque o que está lá dentro
   é o texto cifrado. Guarde-a FORA deste servidor antes do primeiro cliente.

4. Conferir o que você preencheu, sem subir nada:

     bash scripts/conferir-ambiente.sh --dns

   Ele separa erro (não sobe) de aviso (sobe com um recurso desligado) e diz,
   para cada variável em branco, o que exatamente para de funcionar.

5. Do seu Mac:   bash scripts/publicar-imagens.sh 0.1.0
6. Daqui:        bash scripts/atualizar-vps.sh 0.1.0
─────────────────────────────────────────────────────────────────────────────
FIM
