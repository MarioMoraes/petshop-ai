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
| `identity-service` | 3001 | não |
| `tutor-service` | 3003 | não |
| `pet-service` | 3004 | não |
| `medical-record-service` | 3005 | não |
| `scheduling-service` | 3006 | não |
| `billing-ledger-service` | 3007 | não |
| `postgres` / `redis` / `rabbitmq` / `gotenberg` | — | não |
| `migrator` | — | roda uma vez e morre |

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
salvo continua funcionando). A raiz `/` responde **307**, e a diferença é deliberada:
ela vira o site do petshop quando o MOD-SITE entrar, e um 301 ficaria no cache dos
navegadores apontando para o Admin sem como desfazer.

Os sete serviços de backend saem da **mesma imagem** (`infra/Dockerfile`, alvo
`backend`). Eles compartilham as mesmas dependências; sete imagens seriam o mesmo
`node_modules` sete vezes. O `command` de cada container escolhe qual `server.js`
sobe.

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

**6. Segredos.**

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
