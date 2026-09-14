# Deploy numa VPS que já roda EasyPanel

O caso desta instalação: a VPS `72.60.254.125` já hospeda a imobiliária
(`offices-ai`, por `docker compose`) e o EasyPanel, cujo **Traefik ocupa as portas
80 e 443**.

Use `infra/docker-compose.easypanel.yml`. O `docker-compose.swarm.yml` **não serve
aqui**: ele sobe o nosso Caddy nas mesmas portas, e o segundo processo a tentar
simplesmente não sobe.

```sh
cd /opt/petshop
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production up -d
```

## O que muda ao perder a nossa borda

| | Com o nosso Caddy | Aqui |
|---|---|---|
| Certificado | wildcard `*.petshop…`, por DNS-01 | um por host, por HTTP-01 |
| Host de tenant novo | automático | entra em `PETSHOP_HOSTS` + `up -d` |
| `CLOUDFLARE_API_TOKEN` | obrigatório | **não é usado** |
| Cabeçalhos de segurança e CSP | aplicados pelo Caddyfile | ausentes |

**A ausência do wildcard é a dívida desta configuração.** O slug de cada
estabelecimento é subdomínio e vai impresso em QR code; nomear host a host serve
para dois ou três petshops de teste e não escala para clientes reais. Quando
escalar for necessário, as saídas são um certificado wildcard configurado no
próprio EasyPanel ou a nossa borda de volta — o que exige tirar o EasyPanel das
portas 80/443.

## A máquina é apertada

```
3.8 GB de RAM · 1 vCPU · sem swap
```

A imobiliária já usa ~1.6 GB. O petshop em repouso pede ~1 GB, o que cabe — mas o
**pico** não perdoa: o Gotenberg sobe um Chromium por PDF (+500 MB e um núcleo por
alguns segundos) e, sem swap, quem decide a vítima é o OOM killer. Ela pode ser o
Postgres da imobiliária.

**Crie swap antes do primeiro deploy:**

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Swap não substitui memória: transforma um kill silencioso em lentidão. Num
servidor com dois produtos, é a diferença que importa.

Se ainda apertar, corte nesta ordem — os dois já existem na máquina, rodando para
a imobiliária:

1. **Gotenberg** (`offices-ai-gotenberg-1`) — stateless, acoplamento nenhum.
2. **Evolution** (`offices-ai-evolution-1`, **a mesma versão v2.3.7**) — ela é
   multi-instância por desenho, mas um restart passa a afetar o WhatsApp dos dois
   produtos.

Para reaproveitar qualquer um, o serviço do petshop precisa entrar na rede
`offices-ai_interna` (declarada como `external`) e apontar `GOTENBERG_URL` /
`EVOLUTION_API_URL` para o nome do container de lá.

## Por que o Postgres NÃO é compartilhado

É a pergunta que mais volta, e a resposta é específica:

```sql
-- imobiliaria/infra/postgres/init.sql
CREATE ROLE app_user LOGIN PASSWORD 'app_user';

-- petshop .../20260822130000_rls_policies/migration.sql
CREATE ROLE app_user LOGIN PASSWORD 'app_user';
```

Os dois produtos criam **a mesma role**, e em seguida cada um troca a senha pela
sua. Role no Postgres é do **cluster**, não do database: numa instância só existe
um `app_user`, e cada deploy de qualquer um dos dois reescreveria a senha do
outro. A imobiliária cairia sozinha toda vez que o petshop fosse atualizado, sem
relação visível com a causa.

Unificar exige renomear as roles do petshop (`petshop_app`,
`petshop_maintenance`), o que toca a migration de RLS. É uma mudança contida, mas
merece ser feita depois que o petshop estiver de pé — não antes do primeiro deploy
bem-sucedido. A imagem a usar seria a `pgvector/pgvector:pg16` da imobiliária, que
é Postgres 16 como a nossa e superset dela.

## Acrescentar um estabelecimento

1. Registro `A` na Cloudflare: `{slug}.petshop.officestecnologia.com.br` →
   `72.60.254.125`, **DNS-only** (nuvem cinza).
2. Acrescente à regra em `.env.production`:

```sh
PETSHOP_HOSTS='Host(`petshop.officestecnologia.com.br`) || Host(`app.petshop.officestecnologia.com.br`) || Host(`joao.petshop.officestecnologia.com.br`)'
```

3. `docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production up -d`

> **Aspas simples, sempre.** O arquivo é lido de dois jeitos: o compose o parseia
> literalmente e o `conferir-ambiente.sh` o carrega pelo bash. Entre aspas duplas
> o bash trataria as crases como substituição de comando; escapá-las resolveria
> para o bash e quebraria para o compose, que entregaria a barra invertida ao
> Traefik — e a regra seria recusada. `conferir-ambiente.sh` reprova esse caso,
> lendo a linha crua do arquivo.

## Rotas publicadas

Só duas chegam ao backend, e as duas só no domínio da aplicação:

```
petshop.officestecnologia.com.br/internal/v1/clerk/webhook
petshop.officestecnologia.com.br/internal/v1/email/webhook
```

Todo o resto vai para o Next. **`/v1` não tem rota na borda**: o cliente HTTP do
frontend é `server-only`, o navegador nunca fala com o backend, e a superfície
pública da API é zero.

As prioridades do Traefik (`200` no backend, `100` no frontend) não são
decorativas: o EasyPanel mantém um router `https-error-page` com
`HostRegexp(.+)` e priority 1 — empatar com ele é sorteio —, e o backend precisa
ficar acima do frontend, cuja regra pega tudo e engoliria `/internal`.

## Diagnóstico

```sh
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production ps
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production logs -f backend
```

**A página 404 do EasyPanel em vez da aplicação** — o host não está em
`PETSHOP_HOSTS`, ou a regra tem crase escapada. Rode `conferir-ambiente.sh`.

**Certificado inválido num host de tenant** — o registro DNS não existe, ou está
em nuvem laranja. O HTTP-01 precisa alcançar a máquina pelo nome.

**`network easypanel not found`** — confirme o nome real com
`docker network ls | grep -i easypanel` e ajuste `TRAEFIK_NETWORK`.

**Um container morrendo sem log** — provavelmente OOM. `dmesg -T | grep -i oom`
confirma. Foi por isso que o swap veio antes.
