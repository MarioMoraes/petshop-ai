# Deploy em Docker Swarm (VPS Hostinger)

Um nó, uma stack, nove serviços. As imagens são construídas no seu Mac e
publicadas no ghcr.io; a VPS só puxa e sobe.

```
Mac                                  ghcr.io                VPS (swarm)
publicar-imagens.sh 0.1.0  ───push──►  4 imagens  ◄──pull──  atualizar-vps.sh 0.1.0
```

## Por que não é o `docker-compose.prod.yml` com `deploy:` colado

`docker stack deploy` **ignora**, sem aviso, quatro coisas de que aquele arquivo
depende:

| Ignorado em Swarm | O que fazia no compose | Substituto aqui |
|---|---|---|
| `build:` | construía na VPS | imagens do ghcr.io (`publicar-imagens.sh`) |
| `depends_on:` | segurava os serviços até a migração terminar | `infra/swarm/aguardar-migracao.sh` |
| `env_file:` / `--env-file` | carregava o `.env.production` | `set -a; . .env.production` antes do deploy |
| `restart: unless-stopped` | reiniciava container caído | `deploy.restart_policy` |

O segundo é o que morde. Sem `depends_on`, num banco novo o backend sobe
antes de a role `app_user` existir — e **não caem**: o Prisma conecta
preguiçosamente e o `/health` responde `{"status":"ok"}` sem tocar no banco. O
Swarm mostraria um serviço verde servindo 500 em toda requisição.

O gate resolve isso perguntando ao banco quantas migrações entraram e comparando
com quantas a **própria imagem** carrega em `packages/db/prisma/migrations/`. Não
é "o Postgres respondeu": é "o schema que este código espera está aplicado".
Combinado com `update_config.order: start-first`, o container antigo continua
atendendo enquanto o novo espera — a migração acontece no meio, sem janela de erro.

---

## Primeiro deploy

### 0. A VPS

Mínimo confortável: **2 vCPU / 4 GB**. Em repouso a stack fica perto de **1 GB**
— backend ~200 MB, Next ~200 MB, Postgres ~150 MB, RabbitMQ ~130 MB, Evolution
~250 MB, Redis e Gotenberg o resto. (O número anterior, 3,5 GB, era da era dos dez
serviços Node; a consolidação em monólito o derrubou e a linha tinha ficado para trás.)

O que o número de repouso esconde: o Gotenberg sobe um Chromium para cada PDF, e
ali são +500 MB e um núcleo inteiro por alguns segundos. **Com 1 vCPU e sem swap,
é esse pico que mata** — o OOM killer escolhe a vítima, e ela pode ser o Postgres.
Swap não substitui memória, mas transforma um kill em lentidão.

O `next build` não cabe numa máquina desse porte — e não precisa, porque o build é
no Mac.

```sh
ssh root@<ip>
apt-get update && apt-get install -y git
git clone https://github.com/MarioMoraes/petshop-ai.git /opt/petshop
cd /opt/petshop && bash scripts/preparar-vps.sh
```

O script instala o Docker, inicia o swarm, fecha o firewall em 22/80/443 e cria o
`.env.production` a partir do exemplo. Ele **não** abre 2377/7946/4789 de
propósito: são as portas do swarm, num nó só não são usadas de fora, e abertas
seriam controle do cluster exposto — o `docker swarm join` não pede senha, pede
um token.

### 1. DNS

Dois registros na Cloudflare, **os dois em DNS-only (nuvem cinza)**:

```
A  petshop.officestecnologia.com.br    → <ip da VPS>
A  *.petshop.officestecnologia.com.br  → <ip da VPS>
```

O wildcard não é conforto: o slug de cada tenant é subdomínio e vai impresso em
QR code.

Cinza e não laranja porque quem termina o TLS é o Caddy desta máquina. Além
disso, `*.petshop.officestecnologia.com.br` está um nível abaixo do que o
Universal SSL da Cloudflare cobre — pelo proxy laranja, **todo host de tenant
daria erro de certificado**, e só o primeiro cliente descobriria.

### 2. Token da Cloudflare

`Zone:DNS:Edit` **restrito a essa zona**, não a Global API Key. É ele que assina
o desafio DNS-01. Sem DNS-01 não sai wildcard; sem wildcard nenhum petshop abre.

### 3. Segredos

```sh
cd /opt/petshop
vim .env.production      # já criado pelo preparar-vps.sh, com permissão 600
```

```sh
openssl rand -base64 32 | tr -d '/+=' | head -c 40    # senhas de role
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **A KEK antes de tudo.** `ENCRYPTION_KEK` é a raiz de tudo que é cifrado no
> banco. Perdê-la é perder o PII de todos os tenants — o backup não salva, porque
> o que está lá dentro é o texto cifrado. Guarde-a **fora deste servidor** antes
> do primeiro cliente real entrar.

### 3.1. Conferir o que você preencheu

```sh
bash scripts/conferir-ambiente.sh --dns
```

Não sobe nada — só lê. Existe porque erro de configuração neste projeto quase
nunca aparece como erro, e sim como um serviço verde servindo coisa errada. Ele
separa dois níveis:

- **erro** — o deploy não funciona (variável obrigatória vazia, `sk_live_...`
  deixado como está, senha de role com caractere que o `ALTER ROLE` não aceita,
  registro de DNS em nuvem laranja);
- **aviso** — o deploy funciona com um recurso **desligado em silêncio**, e ele
  diz qual: sem `ANTHROPIC_API_KEY` o agente de IA não responde ninguém embora a
  tela deixe ligá-lo; sem `RESEND_API_KEY` todo e-mail vira log e consta como
  enviado; sem `CLERK_WEBHOOK_SECRET` a sincronização de usuário recusa tudo
  com 401.

`atualizar-vps.sh` roda esta mesma conferência antes do `stack deploy` e aborta
nos erros, então rodá-la aqui é só antecipar a resposta.

### 4. Login no ghcr.io

Na VPS, com um PAT clássico do GitHub de escopo `read:packages` — só leitura, e
só de pacotes:

```sh
echo <PAT> | docker login ghcr.io -u <seu-usuario> --password-stdin
```

### 5. Publicar e subir

No Mac:

```sh
bash scripts/publicar-imagens.sh 0.1.0
```

Na VPS:

```sh
cd /opt/petshop && git pull && bash scripts/atualizar-vps.sh 0.1.0
```

### 6. Depois que a stack subir

Quatro coisas não moram no `.env.production` porque dependem de o endereço já
estar no ar. Nenhuma delas quebra nada se ficar para depois — cada uma liga um
pedaço do produto.

**Webhook do Clerk (MOD-IDENT-03).** No painel do Clerk, endpoint
`https://petshop.officestecnologia.com.br/internal/v1/clerk/webhook`. Ele
devolve um `whsec_…`: é o `CLERK_WEBHOOK_SECRET`. Sem ele a rota recusa tudo com
401 e mudança de nome ou e-mail feita no Clerk não desce para o banco.

**Webhook do Resend (MOD-NOTIF-10).** Endpoint
`https://petshop.officestecnologia.com.br/internal/v1/email/webhook`, e o
`whsec_…` dele é o `RESEND_WEBHOOK_SECRET`. É por onde bounce e reclamação de
spam voltam. **É a única superfície de backend que a borda publica** — as duas
rotas de `/internal/` valem só no domínio da aplicação, nunca nos subdomínios de
tenant, e o que as protege é inteiramente a assinatura Svix sobre o corpo cru.

**O primeiro administrador de plataforma.** Crie a conta pelo Clerk (ou entre uma
vez em `https://app.petshop.officestecnologia.com.br`), ponha esse e-mail em
`PLATFORM_ADMIN_BOOTSTRAP_EMAIL` e redeploy. Vale **só enquanto não houver
nenhum** administrador ativo; depois disso a concessão é pela tela, com trilha.
`/plataforma` responde 404 — não 403 — para quem não é da plataforma, então
"não encontrei a tela" é o sintoma esperado de ainda não ter feito isto.

**Parear o WhatsApp.** Pela tela do CRM em cada estabelecimento. A Evolution não
tem porta publicada nem rota no Caddy de propósito: ela manda mensagem pelo número
da empresa, e só o backend fala com ela pela rede interna.

Ordem sugerida: entre em `app.petshop.officestecnologia.com.br`, crie o primeiro
estabelecimento pelo onboarding, confira que o site dele abre em
`{slug}.petshop.officestecnologia.com.br` — é o que prova que o wildcard saiu — e
só então volte para os webhooks.

---

## Atualizações

Exatamente os mesmos dois comandos, com a versão nova. `docker stack deploy` é
idempotente e só toca no que mudou; `--resolve-image changed` evita rebaixar
serviços cuja imagem não mudou.

## Conferir

```sh
docker stack services petshop
docker service logs -f petshop_api-gateway
curl -sI https://app.petshop.officestecnologia.com.br
```

`petshop_migrator` aparece como **0/1**, e isso é o esperado: é uma tarefa de uma
passada só, que fica `Complete` ao terminar.

O primeiro certificado leva um ou dois minutos (propagação do TXT do DNS-01). Se
demorar muito mais, `docker service logs petshop_caddy` diz se o token não tem
permissão na zona.

## Voltar atrás

```sh
bash scripts/atualizar-vps.sh <versao-anterior>
```

Vale para o **código**. **Migração não volta assim** — o Prisma não desfaz. E há
uma pegadinha específica do gate: o container antigo carrega uma contagem de
migrações menor que a do banco, e a comparação é `>=`, então ele sobe
normalmente. O que ele não faz é entender colunas que ainda não conhecia. Antes
de subir uma migration destrutiva, tire um dump.

## Backup

Não há rotina automática ainda. No mínimo, e fora desta máquina:

```sh
docker exec $(docker ps -qf name=petshop_postgres) \
  pg_dump -U postgres petshop | gzip > petshop-$(date +%F).sql.gz
```

O dump **não** protege o PII sozinho: sem a KEK, o que está nele é ilegível. Os
dois precisam sobreviver, e em lugares diferentes.

## Manutenção com acesso ao banco

A rede overlay é `attachable`, então dá para alcançar o Postgres sem publicar
porta nenhuma:

```sh
docker run --rm -it --network petshop_interna postgres:16-alpine \
  psql postgresql://postgres:<senha>@postgres:5432/petshop
```

---

## Quando algo não sobe

**Task em `Rejected: No such image`** — o `atualizar-vps.sh` puxa as imagens antes
do deploy justamente para não chegar aqui; se chegou, ou o `docker login` no
ghcr.io expirou, ou a versão não foi publicada.

**Serviço reiniciando em laço, log parando em `aguardar-migracao`** — o gate não
liberou. Veja `docker service logs petshop_migrator`. Se o migrator está
`Complete` e o gate ainda espera, a `APP_USER_PASSWORD` do `.env.production`
divergiu da que o `set-role-passwords.ts` gravou: rode
`docker service update --force petshop_migrator`.

**`exec format error`** — a imagem foi construída para arm64 num Mac Apple
Silicon. O `publicar-imagens.sh` passa `--platform linux/amd64`; se você
construiu à mão, é isso.

**Caddy em `port is already allocated`** — outro processo (um Traefik de painel,
um nginx do sistema) está em 80/443. As portas do Caddy são `mode: host`
justamente para ele ver o IP real do cliente, e isso as torna exclusivas.

**Tudo verde e a página não abre** — confira que o `APP_DOMAIN` chegou ao
container do frontend: sem ele o padrão é `localhost:3002` e **todo** host cai no
Admin. Nada fica exposto, mas o site do petshop e o Portal do Tutor não respondem.

```sh
docker service inspect petshop_frontend \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep APP_DOMAIN
```

## O que este deploy ainda não tem

- **Observabilidade.** Nenhum OpenTelemetry, nenhum Sentry. `docker service logs`
  é tudo. Um job que parar de rodar não avisa ninguém.
- **CI.** As imagens saem do Mac, à mão. Nada roda a suíte antes.
- **Backup automático** e teste de restauração.
- **Alta disponibilidade.** Um nó, `replicas: 1`, volumes locais. As restrições
  `node.role == manager` existem para que um segundo nó não reagende o Postgres
  para uma máquina de volume vazio — o banco subiria limpo, sem erro, e o estrago
  só apareceria quando alguém procurasse um cadastro.
