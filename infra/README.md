# Implantação — VPS único com Docker Compose

Um servidor, um `docker compose`, um domínio com wildcard. É o tamanho certo para
um produto que ainda não tem tráfego: tudo num lugar só para olhar, e nada aqui
impede migrar para orquestrador depois — as imagens são as mesmas.

## O que sobe

| Container | Porta | Exposto? |
|---|---|---|
| `caddy` | 80, 443 | **sim** — o único |
| `frontend` | 3002 | não |
| `api-gateway` | 3000 | não |
| `medical-record-service` | 3005 | não |
| `scheduling-service` | 3006 | não |
| `billing-ledger-service` | 3007 | não |
| `postgres` / `redis` / `rabbitmq` / `gotenberg` | — | não |
| `evolution` | 8080 | não — **nem por rota no Caddy** |
| `migrator` | — | roda uma vez e morre |

A Evolution API (canal WhatsApp, MOD-CRM-01) é a única dependência que merece uma
frase à parte: ela envia mensagem pelo número do próprio petshop, então publicá-la
seria oferecer isso à internet com uma chave de API entre ela e o mundo. Quem fala
com ela é só o `messaging-service`, pela rede interna; para depurar, use um túnel
SSH. O database dela é separado (`evolution`, na mesma instância de Postgres) e é
o `migrator` que o cria — em produção não há `docker-entrypoint-initdb.d` montado.

> **Em desenvolvimento, num volume que já existia antes desta fatia**, o
> `postgres/init/02-create-evolution-db.sql` não roda (o init só executa em volume
> novo) e a Evolution sobe reiniciando. Crie o database uma vez:
>
> ```sh
> docker compose -f infra/docker-compose.yml exec postgres \
>   psql -U postgres -c 'CREATE DATABASE evolution'
> ```

O gateway não é publicado de propósito: o cliente HTTP do frontend é `server-only`,
então o browser nunca fala com a API. A superfície pública é uma porta HTTPS.

## Os três hosts

Um processo Next atende três públicos, separados por host — decisão de 2026-08-28,
implementada em `frontend/src/lib/host.ts` e no `middleware.ts`:

| Endereço | Quem | Autenticação |
|---|---|---|
| `{slug}.{APP_DOMAIN}/` | site público do petshop (MOD-SITE) | nenhuma |
| `{slug}.{APP_DOMAIN}/portal` | Portal do Tutor (MOD-PORTAL) | sessão do tutor |
| `app.{APP_DOMAIN}` | Admin da equipe | sessão de equipe (Clerk) |

O Admin tem host próprio por segurança, não por organização: o site público é a
superfície mais exposta do sistema — anônima, cacheada, com formulário aberto ao mundo —
e o cookie de sessão de quem opera o petshop não tem por que dividir origem com ela.

**Nada muda no Caddy:** `app.{APP_DOMAIN}` já está coberto pelo wildcard
`*.{$APP_DOMAIN}`, e `CLERK_AUTHORIZED_PARTIES` já inclui os dois. O que o deploy
precisa é da variável **`APP_DOMAIN` chegando ao container do frontend** — é dela que
o middleware tira qual host é de tenant e qual é da plataforma. Sem ela o padrão é
`localhost:3002`, e **todo** host cai no Admin: nada fica exposto, mas o site e o
Portal não respondem.

Rotas do Admin acessadas no host de um tenant respondem **301** para `app.` (o link
salvo continua funcionando). A raiz `/` e tudo o mais no host do tenant são o **site do
petshop**, servido por reescrita interna para `/s/{slug}` — o visitante nunca vê esse
caminho, e pedi-lo diretamente é 404 em qualquer host.

O site precisa de mais duas variáveis no backend: `FRONTEND_INTERNAL_URL` e
`SITE_REVALIDATE_SECRET` — a última é o que impede qualquer um na rede interna de forçar
re-render de todos os sites em laço. Sem `FRONTEND_INTERNAL_URL` a página continua
servindo, só que atualizada pelo TTL de dez minutos em vez de na hora.

O frontend fala com o site pelo mesmo `API_URL` de todo o resto, no prefixo `/public/`.
Havia uma terceira variável, `SITE_SERVICE_URL`, de quando o site era um serviço à parte
— e **nenhum compose a entregava ao frontend**, então em container a página pública caía
no padrão `localhost:3013` e não respondia. A consolidação do módulo tirou a variável e o
defeito junto.

### `APP_DOMAIN` sob um domínio já existente

Nada obriga o `APP_DOMAIN` a ser um domínio de segundo nível. Instalar em
`petshop.officestecnologia.com.br` funciona: o que separa o slug do domínio é a
**primeira label**, não a contagem de pontos, e o corte é o mesmo sufixo de sempre.

```
petshopdojoao.petshop.officestecnologia.com.br/         site
petshopdojoao.petshop.officestecnologia.com.br/portal   Portal
app.petshop.officestecnologia.com.br                    Admin
petshopdojoao.officestecnologia.com.br                  NÃO é a instalação → Admin
```

O que muda é a **borda**, e são dois pontos:

- **O wildcard vira de dois níveis para a zona.** `*.petshop.officestecnologia.com.br`
  é um nível abaixo do que o Universal SSL da Cloudflare cobre, então o registro tem de
  ficar em **DNS-only (nuvem cinza)**. Não é perda: o Caddy já emite o próprio
  certificado por DNS-01 e é ele quem termina o TLS. Passar pelo proxy laranja daria
  erro de certificado em todo host de tenant.
- **O token de DNS continua sendo o da zona `officestecnologia.com.br`.** O desafio
  DNS-01 grava `_acme-challenge` dentro dela; `Zone:DNS:Edit` restrito a essa zona
  basta, e o `APP_DOMAIN` não precisa ser uma zona própria.

Um detalhe menor do `Caddyfile`: o `preload` do HSTS só vale para apex, então num
domínio assim ele é ignorado pela lista — o `max-age` e o `includeSubDomains` seguem
valendo.

Os onze serviços de backend saem da **mesma imagem** (`infra/Dockerfile`, alvo
`backend`). Eles compartilham as mesmas dependências; onze imagens seriam o mesmo
`node_modules` onze vezes. O `command` de cada container escolhe qual `server.js`
sobe.

## Dois caminhos de deploy

| | `docker-compose.prod.yml` | `docker-compose.swarm.yml` |
|---|---|---|
| Orquestrador | Docker Compose | Docker Swarm |
| Imagens | construídas na própria VPS | ghcr.io, construídas no Mac |
| Ordem da migração | `depends_on: service_completed_successfully` | `infra/swarm/aguardar-migracao.sh` |
| Runbook | este arquivo | **[docs/deploy-swarm.md](../docs/deploy-swarm.md)** |

**Se a sua VPS roda Swarm, vá para `docs/deploy-swarm.md`** — o resto desta seção
descreve o caminho com Compose. As duas primeiras etapas (DNS e token da
Cloudflare) valem para os dois; a partir de "Deploy" elas divergem.

## Antes do primeiro deploy

**1. DNS.** Na Cloudflare, aponte `A meupetshop.com.br` e `A *.meupetshop.com.br`
para o IP do VPS. O wildcard não é conforto: o slug do tenant é subdomínio e vai
impresso em QR code.

**2. Token de DNS.** Crie um token com `Zone:DNS:Edit` **restrito a essa zona** —
é o que assina o desafio DNS-01 do certificado wildcard. Não use a Global API Key.

**3. Clerk de produção.** Instância separada da de teste, com o template de JWT
`petshop` publicando o claim `permVersion` (`docs/setup-clerk.md`). O gateway
compara esse claim; sem ele toda sessão cai no caminho degradado.

**4. Bucket R2 de produção**, separado do de desenvolvimento.

**5. Resend (opcional no primeiro dia).** O convite de equipe (MOD-IDENT-06) sai
por e-mail quando `RESEND_API_KEY` existe e o domínio de `MAIL_FROM` está
verificado na conta (SPF + DKIM). Sem a chave nada quebra: o convite é criado
igual e o link aparece na tela de Equipe, para o admin entregar por WhatsApp.

**6. Chave da Evolution API.** `EVOLUTION_API_KEY` no `.env.production` — é a senha
da API que pareia e envia pelo WhatsApp dos tenants. Gere uma aleatória como as
senhas de role. Sem ela o canal fica indisponível e tudo cai para o e-mail.

**7. Segredos.**

```sh
cp .env.production.example .env.production
chmod 600 .env.production
# preencha tudo; as senhas de role aceitam só [A-Za-z0-9._~-]
openssl rand -base64 32 | tr -d '/+=' | head -c 40
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # a KEK
```

> **A KEK antes de tudo.** `ENCRYPTION_KEK` é a raiz de tudo que é cifrado no
> banco. Perdê-la é perder o PII de todos os tenants — backup do banco não
> resolve, porque o que está lá dentro é o texto cifrado. Guarde-a **fora deste
> servidor** antes do primeiro cliente real entrar.

## Deploy

```sh
export IMAGE_TAG=$(git rev-parse --short HEAD)   # saber o que está no ar
docker compose -f infra/docker-compose.prod.yml --env-file .env.production build
docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d
```

O `migrator` roda primeiro e sozinho; os serviços têm
`depends_on: {migrator: service_completed_successfully}`, então **se a migração
falhar, nada sobe com o schema errado**. Ele faz três coisas, nesta ordem:

1. `prisma migrate deploy`
2. `set-role-passwords.ts` — a migration cria `app_user` com a senha `'app_user'`,
   boa para desenvolvimento e inaceitável aqui; só o owner consegue trocar, e só
   depois que a role existe
3. `prisma/seed.ts` — permissões e catálogo global, idempotente

Acompanhe: `docker compose -f infra/docker-compose.prod.yml logs -f migrator`

## Verificar

```sh
docker compose -f infra/docker-compose.prod.yml ps
docker compose -f infra/docker-compose.prod.yml exec api-gateway \
  curl -sf http://localhost:3000/health
curl -sI https://meupetshop.com.br
```

O primeiro certificado leva um ou dois minutos (propagação do TXT do DNS-01). Se
demorar mais, `docker compose logs caddy` diz se o token não tem permissão.

## Rollback

```sh
IMAGE_TAG=<sha-anterior> docker compose -f infra/docker-compose.prod.yml \
  --env-file .env.production up -d
```

Vale para o código. **Migração não volta assim** — o Prisma não desfaz. Antes de
subir uma migration destrutiva, tire um dump.

## Backup

Não há rotina automática ainda; enquanto não houver, no mínimo:

```sh
docker compose -f infra/docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres petshop | gzip > petshop-$(date +%F).sql.gz
```

O dump **não** protege o PII sozinho: sem a KEK, o que está nele é ilegível. Os
dois precisam sobreviver, e em lugares diferentes.

## O que este deploy ainda não tem

Registrado para não parecer esquecimento:

- **Observabilidade.** Nenhum OpenTelemetry, nenhum Sentry. `docker compose logs`
  é tudo. Um job que parar de rodar não avisa ninguém.
- **CI.** As imagens são construídas no servidor, à mão. Nada roda a suíte antes.
- **Backup automático** e teste de restauração.
