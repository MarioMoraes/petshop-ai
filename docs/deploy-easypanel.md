# Deploy numa VPS que já roda EasyPanel

O caso desta instalação: a VPS `72.60.254.125` já hospeda a imobiliária
(`offices-ai`, por `docker compose`) e o EasyPanel, cujo **Traefik ocupa as portas
80 e 443**.

Use `infra/docker-compose.easypanel.yml`. O `docker-compose.swarm.yml` **não serve
aqui**: ele publica o nosso Caddy em 80/443, e o segundo processo a tentar ocupar
uma porta ocupada simplesmente não sobe.

```sh
cd /opt/petshop
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production up -d
```

## A borda: o Caddy atrás do Traefik

A primeira versão desta configuração não tinha Caddy — cada serviço se anunciava
ao Traefik do EasyPanel por labels HTTP. O custo era o certificado: **o Traefik
do EasyPanel emite por HTTP-01, que não faz wildcard**, então todo host precisava
estar nomeado numa lista (`PETSHOP_HOSTS`).

Isso não sobrevive ao produto. O slug do estabelecimento é subdomínio, vai
impresso em QR code, e **nasce quando um cliente se cadastra sozinho pelo
wizard** — sem passar por ninguém. Com uma lista, o site e o Portal do Tutor
desse cliente nasciam mortos, 404 com certificado inválido, até alguém editar um
arquivo e redeployar. E nada avisava: nem log de erro, nem alerta.

A saída é o Caddy de volta, **atrás** do Traefik, sem disputar porta nenhuma:

```
navegador ──443──▶ Traefik  ──router TCP, tls.passthrough──▶  Caddy ──▶ Next
                  (EasyPanel)   casa PETSHOP_HOST_REGEXP      (termina o TLS)
```

`tls.passthrough` faz o Traefik **não** desembrulhar o TLS: ele lê só o SNI do
ClientHello para escolher o destino e encaminha os bytes crus. Quem apresenta
certificado é o Caddy — e por isso o certificado pode ser um wildcard, emitido
por DNS-01 com o token da Cloudflare, que o Traefik nem sabe que existe.

Um router TCP com SNI específico ganha dos routers HTTP no mesmo entrypoint:
eles vivem atrás de um `HostSNI(*)` interno, o mais genérico possível. É o que
faz a regra valer sem competir em prioridade com o `https-error-page` do
EasyPanel. **Nada da configuração do EasyPanel é tocado** — são labels do nosso
serviço.

| | Lista de hosts (antes) | Caddy por passthrough (agora) |
|---|---|---|
| Certificado | um por host, HTTP-01 | wildcard `*.petshop…`, DNS-01 |
| Host de tenant novo | `PETSHOP_HOSTS` + `up -d` | **automático** |
| `CLOUDFLARE_API_TOKEN` | não usado | **obrigatório** |
| Cabeçalhos de segurança e CSP | ausentes | aplicados pelo Caddyfile |
| IP do cliente | direto | por PROXY protocol (v2) |

### PROXY protocol, e por que ele não é opcional

Passthrough entrega bytes crus: sem PROXY protocol o Caddy veria o IP do
container do Traefik em **toda** requisição. O `X-Forwarded-For` que ele monta
viraria constante, e o rate limit do backend — que confia nele por
`trustProxy: true` — contaria o mundo inteiro num balde só. O sintoma seria um
Portal trancando sozinho sob carga normal, sem erro em lugar nenhum.

Daí `PROXY_PROTOCOL_ALLOW`, que precisa ser a sub-rede **real** da rede do
Traefik:

```sh
docker network inspect easypanel -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'
```

O `allow` do Caddy é o que impede que o cabeçalho vire a mentira — só de uma
origem listada ele é lido. Ele **aceita** o PROXY, não o exige: origem fora da
lista, ou dentro dela mas sem cabeçalho, passa normalmente com o IP do socket. É
por isso que o mesmo Caddyfile serve à borda dedicada, onde ninguém envia PROXY
nenhum.

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

Só o DNS:

1. Registro `A` **curinga** na Cloudflare: `*.petshop.officestecnologia.com.br` →
   `72.60.254.125`, **DNS-only** (nuvem cinza). Feito uma vez, serve a todos.
2. Não há passo 2. O regexp da borda já casa o host, e o Caddy pede o
   certificado ao abrir — o wildcard cobre o slug que ainda não existia quando
   ele foi emitido.

> A nuvem precisa ficar **cinza**. Em laranja a Cloudflare termina o TLS e o
> ClientHello que chega ao Traefik é o dela: o SNI continua certo, mas o
> certificado que o visitante vê passa a ser o da Cloudflare, e o `allow` do
> PROXY protocol deixa de descrever quem de fato conecta.

`PETSHOP_HOST_REGEXP` só muda se o `APP_DOMAIN` mudar. Os pontos vão
**escapados** (`\.`): sem escape, `.` casa qualquer caractere e a borda aceita
domínio que não é seu. `conferir-ambiente.sh` exercita a regra contra o ápice,
`app.`, um host de tenant e um contra-exemplo — e reprova os três defeitos.

> **Aspas simples, sempre.** O arquivo é lido de dois jeitos: o compose o parseia
> literalmente e o `conferir-ambiente.sh` o carrega pelo bash. Entre aspas duplas
> o bash consome as barras invertidas do regexp, e a regra chega ao Traefik sem
> os escapes.

## Rotas publicadas

Só três chegam ao backend, e as três só no domínio da aplicação:

```
petshop.officestecnologia.com.br/internal/v1/clerk/webhook
petshop.officestecnologia.com.br/internal/v1/email/webhook
petshop.officestecnologia.com.br/internal/v1/asaas/webhook
```

Todo o resto vai para o Next. **`/v1` não tem rota na borda**: o cliente HTTP do
frontend é `server-only`, o navegador nunca fala com o backend, e a superfície
pública da API é zero.

Quem desempata agora é o **Caddyfile**, não o Traefik: `backend` e `frontend`
saíram da rede do Traefik e só existem para o Caddy. Tirá-los de lá não é
higiene — é o que impede que o Next seja alcançável por um caminho que não passa
pelo Caddyfile, e portanto sem HSTS, sem CSP e sem os cabeçalhos de segurança.

No Traefik sobrou um router TCP e um HTTP, os dois no serviço `caddy`. O segundo
existe porque passthrough é de TLS: em texto claro não há SNI para casar, e quem
digita o endereço sem `https://` — o caso real de quem lê o slug num cartão —
precisa do desvio para o 443.

## A cobrança (Asaas)

A assinatura dos estabelecimentos é cobrada pelo Asaas, com cartão (pelo Checkout dele)
e PIX (assinatura pela API). Quatro variáveis no `.env.production`:

| Variável | O que faz |
|---|---|
| `ASAAS_API_KEY` | Sem ela, a tela de assinatura abre e não cobra (503) |
| `ASAAS_API_URL` | **Sandbox por padrão.** Produção é `https://api.asaas.com/v3`, trocada junto com a chave |
| `ASAAS_WEBHOOK_TOKEN` | O token cadastrado no painel do Asaas; sem ele o webhook recusa tudo |
| `BILLING_GRACE_DAYS` | Dias de atraso antes de o estabelecimento ficar só em leitura (7) |

No painel do Asaas, em *Integrações → Webhooks*, cadastre
`https://petshop.officestecnologia.com.br/internal/v1/asaas/webhook` com o mesmo token
de `ASAAS_WEBHOOK_TOKEN` e os eventos de **cobranças**, **assinaturas** e **checkout**.

**Antes da chave de produção, passe um pagamento inteiro no sandbox** — PIX e cartão,
do clique ao estabelecimento ativo. O payload do `CHECKOUT_PAID` não está documentado, e
é dele que o cliente do cartão chega ao estabelecimento (`modules/subscription/webhook.ts`).
Se o cartão pago não ativar a conta, é por aí que se começa.

## A landing page de venda

`lp.officestecnologia.com.br` é uma stack à parte (`infra/docker-compose.landing.yml`,
projeto `petshop-landing`): um nginx servindo `frontend/landing-page` direto do
checkout. Não passa pelo Caddy — o host não casa o `PETSHOP_HOST_REGEXP` — e usa um
router HTTP comum do Traefik, com certificado por HTTP-01.

```sh
cd /opt/petshop && git pull
docker compose -f infra/docker-compose.landing.yml --env-file .env.production up -d
```

Mudou só texto ou estilo da landing? `git pull` basta: o diretório é montado como
volume. O `up -d` só é preciso na primeira vez ou quando o compose ou o
`nginx.conf` mudarem (aí com `--force-recreate`).

## Diagnóstico

```sh
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production ps
docker compose -f infra/docker-compose.easypanel.yml --env-file .env.production logs -f backend
```

**A página 404 do EasyPanel, com certificado `CN=Easypanel`** — nenhum router
casou o SNI, então a conexão nem chegou ao Caddy. Confira o regexp com
`conferir-ambiente.sh` e o router com
`docker logs <traefik> 2>&1 | grep -i petshop-tls`.

**Certificado inválido, mas emitido pelo Caddy** — o ACME não terminou. O
DNS-01 depende do token: `docker compose … logs caddy | grep -i acme`. Token sem
`Zone:DNS:Edit` na zona falha em silêncio por minutos antes de desistir.

**Todo mundo trancado pelo rate limit ao mesmo tempo** — `PROXY_PROTOCOL_ALLOW`
não cobre a sub-rede do Traefik, e o backend está vendo um IP só. Confira com
`docker network inspect easypanel -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'`.

**`network easypanel not found`** — confirme o nome real com
`docker network ls | grep -i easypanel` e ajuste `TRAEFIK_NETWORK`.

**Um container morrendo sem log** — provavelmente OOM. `dmesg -T | grep -i oom`
confirma. Foi por isso que o swap veio antes.
