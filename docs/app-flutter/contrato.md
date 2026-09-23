# O contrato do app do tutor

Este arquivo existe para que as telas do app sejam escritas **sem reler o Next**. Ele é
o resumo verificado do que `/portal/v1` responde e do que o app precisa mandar. Tudo
aqui foi medido contra o backend em execução em 2026-09-20, não deduzido da leitura.

A referência viva continua sendo `backend/app/src/modules/portal/routes.ts` e
`packages/shared-types/src/portal.ts` — mas só se abre uma delas quando este arquivo não
responder.

## Onde o app fala com o backend

Desde 2026-09-22 o padrão de compilação é a **VPS**: `flutter run` e `flutter build apk`
sem argumento nenhum já apontam para

```
https://api.petshop.officestecnologia.com.br
```

Para falar com o backend desta máquina:

```
flutter run --dart-define-from-file=dart_defines/local.json
```

Os dois endereços vivem em `app/lib/src/config.dart` (o padrão) e
`app/dart_defines/local.json` (o desvio).

### O que `api.` publica, e o que não publica

O recorte é da **borda**, em `infra/Caddyfile`, e é por caminho:

| Caminho | |
|---|---|
| `/portal/v1` e `/portal/v1/*` | vai ao gateway |
| `/public/v1/portal/tenants` | vai ao gateway (o catálogo da primeira tela) |
| qualquer outro | **404 do Caddy**, sem chegar ao backend |

São exatamente os dezessete caminhos que `lib/src/api/portal_api.dart` chama. O `/v1` do
Admin e o `/platform/v1` do console **não têm endereço na internet** — o que os fecha é a
borda, não a matriz de papéis, e é isso que impede uma rota administrativa nova de nascer
publicada por engano. Rota nova do Portal, por outro lado, já nasce alcançável.

O resto do prefixo `/public/` fica de fora de propósito: ele serve também o site do
tenant, cujo cliente é o servidor do Next, e por isso está **fora do balde de rate limit
geral** (`backend/app/src/app.ts`). Abri-lo publicaria superfície sem teto. O catálogo é
nomeado um a um porque tem o teto por IP dele, dentro do módulo.

Um `api.` só atende **todos** os tenants, porque quem diz de que petshop se fala é o
header `x-petshop-tenant-slug` — um aparelho não tem host. E `api` é slug reservado
(`packages/shared-types/src/identity.ts`), então nenhum estabelecimento o reivindica.

**A Clerk é a mesma instância em dev e na VPS.** Enquanto for, a conta com que se entra no
app de desenvolvimento é a mesma da produção. Quando a produção passar para uma
`pk_live_`, o app precisa de build nova: a chave está assada em `config.dart`.

**Mudar o Caddyfile pede imagem nova da borda** (`infra/Dockerfile.caddy` o assa dentro
da imagem), e portanto `publicar-imagens.sh` + `atualizar-vps.sh`.

## A sessão

O app **não precisa de nada novo no backend**. `resolvePortalSession`
(`backend/app/src/auth/portal-session.ts`) monta a sessão do tutor a partir de dois
cabeçalhos:

```
authorization: Bearer <JWT de sessão do Clerk>
x-petshop-tenant-slug: <slug do petshop>
```

Quatro fatos verificados, cada um com consequência:

- **O token não precisa de `azp`.** O `verifyToken` do `@clerk/backend` só confere o
  `authorizedParties` quando o claim existe (`assertAuthorizedPartiesClaim`), e o token
  de um app nativo não traz host nenhum. Testado: 200. Nada a acrescentar em
  `CLERK_AUTHORIZED_PARTIES`.
- **O template `petshop` é dispensável.** A sessão do Portal usa só o `sub` — não lê
  `org_id`, `permVersion` nem `mfa`. O token de sessão padrão do Clerk basta, e o token
  de um usuário que **também** é da equipe resolve como `TUTOR` mesmo carregando
  Organization: entrando pelo Portal ele tem as nove permissões `_own` e nada mais.
- **O token vive 60 segundos** (`exp - iat`, medido). O app renova por requisição; é por
  isso que `PortalClient` recebe uma função `TokenDeSessao`, e não uma string.
- **O slug vai em toda requisição, inclusive nas anônimas.** Sem ele, 404. Na web ele sai
  do host que o Next serviu; no app é configuração, escolhida na primeira abertura.

`GET /portal/v1/tenant` é anônimo e serve para **validar o slug** que a pessoa digitou:
devolve `name`, `logoUrl`, `brandColor`, `portalEnabled`. Estabelecimento inexistente,
invisível ou em plano sem Portal respondem todos `404 ERR_PORTAL_001` — de propósito.

`GET /portal/v1/me` diz se o vínculo existe e traz `features`
(`portalEnabled`, `onlineBookingEnabled`, `onlineBookingRequiresApproval`,
`taxiEnabled`). **A navegação lê `features`**, nunca uma constante: é assim que o app
degrada sozinho num tenant de plano menor, em vez de abrir uma tela que responderia 402.

Sessão do Clerk sem ficha vinculada **não é erro**: é o estado de quem acabou de criar a
conta. O contexto sai sem `tutorId` e sem permissão, e só as rotas de `/access/*` o
aceitam — qualquer outra responde 401.

## As rotas do MVP

Todas verificadas com 200. `PortalApi` (`app/lib/src/api/portal_api.dart`) é a tradução
um-a-um desta tabela.

| Método e rota | Parâmetros | Devolve |
|---|---|---|
| `GET /portal/v1/tenant` | — (anônimo) | `PortalTenantResponse` |
| `POST /portal/v1/access/challenge` | `PortalChallenge` | `PortalChallengeResponse` |
| `POST /portal/v1/access/verify` | `PortalVerify` | — |
| `GET /portal/v1/me` | — | `PortalContextResponse` |
| `GET /portal/v1/pets` | — | `{ pets: PortalPetSummary[] }` |
| `GET /portal/v1/pets/:petId` | — | `PortalPetDetail` |
| `GET /portal/v1/pets/:petId/timeline` | `cursor?` | `PortalTimelineResponse` |
| `GET /portal/v1/booking/services` | `petId` | `PortalBookingServicesResponse` |
| `GET /portal/v1/booking/availability` | `petId`, `serviceIds`, `date` | `PortalAvailabilityResponse` |
| `GET /portal/v1/booking/taxi` | `petId` | `PortalTaxiOffer` |
| `POST /portal/v1/booking` | `PortalBooking` | `PortalAppointmentDetail` |
| `GET /portal/v1/appointments` | `cursor?`, `limit?` | `PortalAppointmentsResponse` |
| `GET /portal/v1/appointments/:id` | — | `PortalAppointmentDetail` |
| `POST /portal/v1/appointments/:id/cancel` | `PortalCancel` | — |
| `POST /portal/v1/appointments/:id/reschedule` | `PortalReschedule` | `PortalAppointmentDetail` |
| `GET /portal/v1/finance` | — | `PortalFinanceResponse` |
| `GET /portal/v1/finance/statement` | `page?`, `limit?` | `PortalStatementResponse` |
| `GET /portal/v1/finance/statement/pdf` | — | **bytes** (`application/pdf`) |
| `GET /portal/v1/finance/receipts/:paymentId` | — | `PortalReceiptResponse` |

`serviceIds` vai **separado por vírgula** numa string só — a rota repassa a pergunta ao
domínio em vez de recalcular a grade, e é isso que garante que o tutor veja os mesmos
horários que a recepção veria. `date` é `YYYY-MM-DD` no fuso do petshop: quem escolhe é
o **dia**, não um instante.

## Seis coisas que mordem

1. **Nenhum instante chega formatado.** A grade desce em UTC
   (`2026-09-22T13:00:00.000Z`) e o fuso do estabelecimento vem ao lado, na própria
   resposta. Aquele horário é **10:00** para o cliente. Formatar com o fuso do aparelho
   funciona na mesa de quem desenvolve e mente para quem viajou. Por isso toda hora
   visível passa por `TenantTime` (`app/lib/src/time/tenant_time.dart`), que exige o
   fuso no construtor — não há `DateFormat` solto nas telas.

2. **`TenantTime.iniciar()` precisa ser aguardado na subida do app.** O `intl` não traz
   os nomes de mês e dia embutidos, e sem a carga do locale `pt_BR` o formatador lança em
   **execução**, com o `flutter analyze` limpo. Foi assim que o arnês de fumaça pegou.

3. **Os schemas das rotas são `.strict()`.** Parâmetro desconhecido é 422, não algo
   ignorado com boa vontade — `?scope=upcoming` responde `Unrecognized key: "scope"`. A
   lista de agendamentos já vem partida em `upcoming` e `past` na mesma resposta.

4. **O erro carrega mais que a frase.** O `problem+json` traz contexto que torna o erro
   acionável: `alternativeStartsAt` num 409 de horário ocupado ou van cheia, os alertas
   clínicos a reconhecer, o valor da taxa de cancelamento. `PortalError.extra` preserva
   tudo isso — uma tela que só mostrasse `detail` diria "não deu" onde podia dizer "que
   tal às 14h".

5. **`photoUrl` é URL assinada do R2, com validade.** O app exibe e volta a pedir; não
   guarda em banco local nem em cache longo.

6. **Cancelar fora da janela é recusado na primeira tentativa.** O servidor responde
   dizendo quanto custa, e só a segunda chamada — com `acknowledgeFee: true` — grava. A
   consequência é mostrada antes, e quem confirma é a pessoa.

## Os modelos Dart são gerados

`app/lib/src/models/portal_models.dart` (61 classes) **não se edita à mão**. Ele deriva
dos schemas Zod do backend:

```
pnpm --filter @petshop/shared-types run gen:dart
```

O caminho é `packages/shared-types/src/portal.ts` → `z.toJSONSchema` → quicktype → Dart.
Se um campo muda no backend, ele muda aqui na próxima geração e o `flutter analyze`
aponta cada lugar do app que precisava saber. É o motivo de o arquivo existir: uma
segunda verdade digitada à mão envelheceria em silêncio.

Duas decisões dentro do gerador (`packages/shared-types/tool/gen-dart-models.ts`):

- os schemas viram **um documento só**, com cada um sob `definitions` — o quicktype
  nomeia a classe pelo arquivo de *saída*, então gerar um a um daria nomes errados;
- estruturas embutidas são **reatadas** ao schema que as nomeia, por igualdade
  estrutural exata. O `toJSONSchema` embute em vez de referenciar, e sem isso
  `PortalAppointmentsResponse` teria `Upcoming` e `Past` como classes próprias em vez de
  `PortalAppointment`.

## Conferir contra o servidor

```
dart run tool/smoke.dart <token> <slug> [baseUrl]
```

Percorre as rotas do MVP com os modelos gerados. Não é teste de unidade: é a pergunta
que só o servidor responde — se as classes **aceitam** o JSON que as rotas devolvem. Um
modelo que erra um campo opcional passa no `flutter analyze` e estoura na tela.

Para um token de desenvolvimento, sem passar pelo login, a Backend API do Clerk emite um
que serve (e que é, de propósito, do mesmo formato do de um app: sem `azp`):

```bash
SK=$(grep -E '^CLERK_SECRET_KEY=' .env | sed -E 's/^CLERK_SECRET_KEY=//; s/"//g')
SID=$(curl -s -X POST https://api.clerk.com/v1/sessions -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" -d '{"user_id":"<user_...>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST "https://api.clerk.com/v1/sessions/$SID/tokens" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["jwt"])'
```

## O ambiente desta máquina

- `flutter` em `~/development/flutter/bin` (3.38.2, Dart 3.10.0).
- **Android constrói**: há SDK 36.1.0, build-tools, licenças e o AVD
  `Medium_Phone_API_36.1`. O `cmdline-tools` ausente é aviso do `doctor`, não
  impedimento.
- **iOS não constrói aqui**: não há Xcode, e o macOS 12.7.6 não roda uma versão recente
  dele. É limite da máquina, não do código — o Dart das telas é o mesmo para os dois.
- Em desenvolvimento o app é **mais simples** que o Portal web: o slug é digitado, então
  não há `PORTAL_DEV_SLUG` nem `/etc/hosts`.

---

# A autenticação do app (etapa 2)

Tudo abaixo foi medido contra a instância de desenvolvimento em 2026-09-20.

## Por onde o app entra

Sem SDK: a **Frontend API da Clerk, falada direto** por `app/lib/src/auth/clerk_fapi.dart`.
O pacote `clerk_flutter` é 0.0.x, community-maintained, e a própria página diz que a
Clerk não o suporta oficialmente — enquanto o que o app precisa cabe num arquivo nosso.

Todas as chamadas levam `_is_native=1`. Isso põe a Clerk no modo de aplicativo: a sessão
anda por cabeçalho em vez de cookie e — verificado — **dispensa o Turnstile no
cadastro**, que de outro modo exigiria um desafio de navegador impossível de resolver
nativamente.

**Entrar** (conta existente):

1. `POST /v1/client/sign_ins` com `identifier` → `sia_…` e os fatores disponíveis
2. `POST /v1/client/sign_ins/{sia}/prepare_first_factor` com `strategy=email_code` e o
   `email_address_id` que veio no passo 1
3. `POST /v1/client/sign_ins/{sia}/attempt_first_factor` com `strategy=email_code` e o
   código → `complete` e `created_session_id`

**Criar conta** (o mesmo e-mail, sem conta):

1. `POST /v1/client/sign_ups` com `email_address` e `password`
2. `POST /v1/client/sign_ups/{sua}/prepare_verification` com `strategy=email_code`
3. `POST /v1/client/sign_ups/{sua}/attempt_verification` → `complete`

**Renovar**: `POST /v1/client/sessions/{sess}/tokens`. **Sair**: `…/remove`.

## Quatro coisas que a instância impõe

- **Só e-mail.** `phone_number` está desligado; a identificação é `email_address` ou
  Google. O vínculo (`/access/challenge`) continua aceitando telefone, porque ali o
  contato é o da **ficha do petshop**, não o da conta.
- **`email_code` é primeiro fator** — dá para entrar sem senha.
- **O cadastro exige senha** (`password: required` no `auth_config`). É por isso que a
  tela de entrada pede senha **só** quando a conta não existe; de entrada em diante, o
  caminho é sempre o código.
- **Nenhum segundo fator** (`second_factors: []`). O app não lida com MFA.

## As três que mordem

1. **O token de cliente rotaciona.** Toda resposta da FAPI pode trazer um `Authorization`
   novo no cabeçalho, e reusar o anterior responde `signed_out` — não `unauthorized`, o
   que manda procurar no lugar errado. `ClerkFapi._chamar` grava o cabeçalho a cada
   resposta, sem exceção.

2. **`form_identifier_not_found` não é erro, é caminho.** É o sinal de que o e-mail não
   tem conta, e a tela passa a pedir a senha para criar uma. Mostrá-lo como falha
   quebraria a decisão do Portal de que entrar e criar conta são a mesma porta.

3. **`toJson` gerado manda `null` onde o app queria silêncio.** Os schemas das rotas são
   `.strict()`, e um campo `.optional()` recusa `null` com 422 (`expected string,
   received null`) — um erro que não aponta para o gerador. O corte fica em `semNulos`
   (`api/portal_client.dart`), aplicado **por chamada**: em `UpdateOwnPetSchema`,
   `birthDate`, `neutered` e `notes` são `.nullable()` *e* `.optional()`, e ali `null`
   quer dizer **apague** enquanto ausente quer dizer **não mexa**. Cortar por atacado
   transformaria "apagar a data de nascimento" num silêncio.

## Os quatro estados do app

`Sessao` (`app/lib/src/auth/sessao.dart`) não navega — **ela está num estado**, e cada um
tem uma tela. Quem não escolheu petshop não pode "voltar" para os pets; quem não vinculou
não tem para onde ir. Um `Navigator` com pilha abriria caminhos que o backend responderia
com 401.

| Estado | Tela | Sai dele quando |
|---|---|---|
| `semPetshop` | Escolher petshop | `GET /portal/v1/tenant` confirma o slug |
| `semConta` | Entrar | a Clerk devolve `created_session_id` |
| `semVinculo` | Vincular | `/access/verify` liga a ficha |
| `pronta` | Início | — |

**O petshop vem antes da conta**, e não é ordem arbitrária: o mesmo login pode ser
cliente de dois estabelecimentos, com fichas diferentes em cada um, e a tela de entrada
mostra a marca de quem está sendo visitado.

`ERR_PORTAL_006` cobre tanto "nunca vinculou" quanto "vínculo revogado" — a mesma
resposta de propósito, e para o app dá no mesmo, porque a saída dos dois é a mesma tela.

## Conferir sem emulador

```
CLERK_PUBLISHABLE_KEY=pk_test_… \
  dart run tool/smoke_auth.dart <email> <codigo> <slug> [baseUrl]
```

Percorre entrar → renovar → apresentar ao Portal → pedir vínculo → sair, com as classes
do app. Numa instância de desenvolvimento, um e-mail com `+clerk_test` aceita o código
fixo `424242`, o que torna a verificação repetível sem caixa de entrada.

Foi este arnês que apanhou o `null` do item 3 — o emulador tinha caído, e a tela sozinha
nunca teria mostrado.

## O Android desta máquina

`flutter build apk --debug` + `adb install` funcionam, e o app roda. Duas linhas de
manifesto que o app precisa e o `flutter create` não põe:

- `INTERNET` no manifesto **principal** (o scaffold só a declara em depuração, para o
  hot reload — sem ela a versão publicada não fala com backend nenhum);
- `usesCleartextTraffic` **só** no manifesto de depuração, porque em dev o backend é
  `http://10.0.2.2:3000` e o Android 9+ recusa cleartext com um erro de socket que não
  explica o motivo. A versão publicada nunca fala http.

`10.0.2.2` é como o emulador alcança o `localhost` da máquina.

O emulador API 36 x86 sobre macOS 12.7.6 **é instável** — caiu no meio da verificação,
com `adb: device offline`. É limite da máquina; a verificação de lógica não depende dele,
e é por isso que o arnês acima existe.

---

# Meus Pets (etapa 3)

Três telas e um formulário: a lista, a ficha com o histórico embaixo, e a folha inferior
que edita os quatro campos que o tutor pode mexer. A rota nova em relação à tabela acima
é uma só:

| Método e rota | Corpo | Devolve |
|---|---|---|
| `PATCH /portal/v1/pets/:petId` | `UpdateOwnPet` | `PortalPetDetail` |

## A chamada onde `semNulos` é o defeito

Todo o resto do app corta os nulos antes de enviar, porque `toJson` gerado escreve
`"campo": null` onde o app queria silêncio e o schema `.strict()` responde 422. **Esta
chamada é a exceção, e ela é o motivo de o corte ser por chamada e não no cliente.**

Em `UpdateOwnPetSchema`, `birthDate`, `neutered` e `notes` são `.nullable()` *e*
`.optional()`: `null` quer dizer **apague** e ausente quer dizer **não mexa**. O
formulário manda os quatro campos sempre, com os nulos, como a web manda — quem limpou a
data de nascimento pediu para voltar ao "não sei", e cortar o `null` transformaria esse
pedido num silêncio: a folha fecharia dizendo que salvou, com a data velha intacta.
`test/atualizar_pet_test.dart` é a guarda disso.

Peso, porte, raça e pelagem não estão no schema, então a recusa acontece **antes** do
handler. Eles aparecem na ficha como leitura, com a frase que diz por quê — campo
desabilitado num formulário é convite a tentar.

## Divergências conscientes do plano e da web

- **"Ver mais", e não rolagem infinita.** O plano do app previa rolagem infinita; a web
  já tinha decidido o contrário, e o motivo — no 4G ela dispara buscas que ninguém pediu
  — só fica mais forte num celular. A primeira página do histórico desce junto da ficha,
  numa chamada que já ia acontecer.
- **A ficha e o histórico saem na mesma ida**, com os dois futuros disparados antes do
  primeiro `await`. É o `Promise.all` da página da web.
- **O pet falecido não mostra o botão de editar.** O servidor recusa o `PATCH` com 404
  (AC-05); oferecer o que será recusado é pior do que não oferecer.

## O que a etapa acrescentou fora das telas

- `ui/dados.dart` — `CarregarDados<T>`: os três estados (girando, falha com "tentar de
  novo", dado) e o puxar-para-atualizar, num lugar só. Uma tela que tratasse só dois
  mostraria giro eterno quando o 4G cai.
- `ui/listas.dart` — `PilhaDeLinhas`, `Linha`, `Retrato`, `CabecalhoDeSecao`,
  `LinhaDeDado`, `EstadoVazio`: a tradução de `frontend/src/app/(portal)/list.tsx`. A
  linha inteira é o alvo, e as linhas moram num cartão só.
- `telas/pets/rotulos.dart` — os textos da ficha fora das telas, porque são regra de
  leitura e regra se testa sem pintar pixel (`test/rotulos_pet_test.dart`).
- `flutter_localizations` com `pt_BR`: sem ele o seletor de data do Material abre em
  inglês. Ele **fixa `intl` em 0.20.2**, e foi por isso que a restrição do pubspec desceu
  de `^0.20.3`.

## Vincular a conta de teste em dev

O `+clerk_test` entra em qualquer instância de desenvolvimento com o código fixo
`424242`, mas em dev ele **não tem espelho local**: quem cria a linha de `users` é o
webhook `user.created` do Clerk, que não alcança esta máquina. Sem o espelho,
`/access/verify` responde "Não foi possível concluir o acesso" — a guarda de
`routes.ts`, não um defeito.

O caminho que funciona, pelo código de produção:

```bash
# 1. o espelho, como o webhook o criaria
cd backend/app && pnpm exec dotenv -e ../../.env -- tsx -e \
  "import('./src/modules/identity/users/service.js').then(m => m.ensureLocalUser('user_...').then(u => console.log(u)))"

# 2. apontar a ficha para ele (dev: o vínculo real exige o código no contato do tutor)
docker exec petshop-postgres psql -U postgres -d petshop -c \
  "update tutors set portal_user_id='<id do espelho>' where id='<id do tutor>';"

# 3. o cache da sessão do Portal guarda o par tenant×user por um minuto
docker exec petshop-redis redis-cli FLUSHALL
```

---

# Marcar horário (etapa 5)

Uma tela só, `telas/agendar/marcar_horario.dart`, e três rotas que já estavam na tabela
do MVP — `GET /booking/services`, `GET /booking/availability`, `POST /booking`.

## A resposta do POST não é o detalhe do agendamento

**Corrige uma suposição da fatia 1.** `POST /portal/v1/booking` devolve `CreatedBooking`
(`modules/portal/booking.ts`), que **não** é `PortalAppointmentDetail`:

| Só no detalhe | Só na criação |
|---|---|
| `actions`, `petId`, `serviceIds`, `source`, `cancelledAt`, `cancelledLate` | `duplicate`, `taxiWarning` |

`CreatedBooking` é uma `interface` do TypeScript, não um schema Zod — então o gerador não
a alcança, e `AgendamentoCriado` (`api/agendamento_criado.dart`) é a **única classe do
app escrita à mão**. O que impede essa cópia de envelhecer em silêncio é
`tool/smoke_booking.dart`, que marca e cancela um horário de verdade; foi ele que apanhou
a suposição — a tela nunca teria mostrado outra coisa senão um erro de tipo.

```
dart run tool/smoke_booking.dart <token> <slug> [baseUrl]
```

Ele marca o **último** horário de um dia 21 dias à frente e cancela em seguida. Deixa uma
linha `CANCELLED` na agenda de desenvolvimento: é o preço de provar a escrita.

## O que a tela decide

- **Uma coluna que cresce**, e não um assistente com Avançar e Voltar — a decisão é da
  web, e num celular ela vale ainda mais: o tutor marca quatro vezes por ano, com o
  polegar, e trocar de ideia é rolar para cima.
- **A numeração dos passos é montada**, porque o cartão do pet só existe para quem tem
  mais de um.
- **Só a última busca vale** (`_busca`): trocar de serviço ou de dia duas vezes num 4G
  ruim deixa duas consultas no ar, e a que chegasse por último venceria — é o horário
  fantasma que o assistente do Admin já teve. `test/telas_agendar_test.dart` completa as
  duas fora de ordem de propósito.
- **O instante volta como veio**: `DateTime.parse` de um texto com `Z` é um instante em
  UTC e `toIso8601String` o devolve com o `Z`. Um `toLocal()` no meio mandaria a hora do
  aparelho com cara de UTC, e o pet chegaria três horas atrasado.
- **`ERR_AGENDA_009` é um "tem certeza?"**: a primeira recusa acende
  `acknowledgedAlerts` e o botão passa a dizer "Confirmar mesmo assim". Pedir a mesma
  resposta duas vezes sem mudar o texto é o que faz alguém tocar de novo achando que a
  primeira falhou.
- **O 409 aponta a saída**: `alternativeStartsAt` vira botão, e só para os instantes que
  existem na grade em tela — é de lá que sai o profissional, e horário sem profissional
  não é pedido válido.
- **`minNoticeHours` vira frase.** Quando o dia escolhido é hoje, a tela diz por que o
  começo do dia sumiu. A web tem o número e não o usa; aqui ele explica a grade que
  começa às 14h em vez de parecer defeito.
- **O comprovante para a tela.** Sem "Meus agendamentos" ainda, voltar sozinho ao Início
  apagaria o que o tutor acabou de fazer em cinco toques.

## O que ficou fora, de propósito

**O leva-e-traz.** É um ramo inteiro — oferta, duas pernas, endereço, janela, a recusa
por falta de vaga com horários alternativos e o "marcar sem o leva-e-traz" — e sozinho
custa quase uma etapa. `features.taxiEnabled` não muda nada nesta tela; quem quiser o
transporte continua pedindo pela web.

**Observações no pedido.** A web também não as oferece; `notes` sai do corpo pelo
`semNulos`.

## Duas armadilhas de teste que custaram tempo

- **`R$ 90,00` tem espaço inquebrável** (U+00A0) entre o símbolo e o número, como o
  `pt_BR` do ICU manda. `find.text('R\$ 90,00')` com espaço comum não acha nada.
- **O botão de confirmar nasce abaixo da dobra**, porque a coluna cresce a cada resposta.
  `ensureVisible` antes de tocar — um toque fora da tela não erra, ele não acontece.

---

# Meus Agendamentos (etapa 4)

Fecha o MVP. Três telas — a lista, a folha de cancelamento e a de remarcar — sobre quatro
rotas que já estavam na tabela: `GET /appointments`, `GET /appointments/:id`,
`POST .../cancel` e `POST .../reschedule`.

## A armadilha da paginação

`GET /portal/v1/appointments` devolve **os próximos inteiros em toda página**: o cursor
só vale para o bloco `past`. Quem acrescentar a resposta inteira a cada "ver mais" faz o
compromisso de sexta aparecer duas vezes, três, quatro — e o defeito não dá erro nenhum.
Só `past` é acrescentado; `upcoming` é sempre o da última resposta.

## O que vem do servidor, e não da tela

- **`actions` decide os botões.** Cancelar e remarcar aparecem porque o servidor disse
  que cabem; a janela de cancelamento é configuração do petshop e muda sem que ninguém
  publique app. Uma tela que recalculasse isso mostraria "Cancelar" para quem já está
  com o pet no banho.
- **`ERR_PORTAL_011` é a segunda palavra do servidor.** A folha já abre com o valor da
  taxa quando `cancelIsLate`, e manda `acknowledgeFee` junto — mas o servidor ainda
  recusa se a tela estiver velha (o app ficou aberto e a janela de 24h fechou). Nesse
  caso a folha **não cancela às escondidas**: adota o `feeCents` que veio no corpo,
  reescreve o aviso e espera o segundo toque.
- **`serviceIds` só existe no detalhe.** Por isso remarcar carrega
  `GET /appointments/:id` antes da grade: reconstruir o conjunto a partir dos rótulos
  exigiria casar texto com catálogo.
- **Remarcar devolve outro registro.** O id da resposta é novo e o anterior já é
  histórico; o arnês confere isso e falha se vier o mesmo.

## A grade mora fora das duas telas

`telas/agendar/grade_de_horarios.dart` guarda `buscarGrade`, `GradeDeHorarios`,
`BotaoDeHora` e `RecusaComAlternativas`. Marcar e remarcar fazem **a mesma pergunta com
os mesmos serviços** — duas cópias divergiriam no dia em que a antecedência mínima
passasse a filtrar diferente, e a tela de remarcar ofereceria um horário que o POST
recusa. A guarda da última busca (três linhas) fica em cada tela, porque é estado dela.

## O leva-e-traz aparece, mas não se pede

O app mostra as corridas de um agendamento (`legLabel`, `statusText` e a janela, nada
mais) porque escondê-las faria o tutor achar que o transporte se perdeu. As duas telas
dizem o que acontece com ele: a folha de cancelamento avisa que cai junto e sem
cobrança (AC-06 de MOD-PORTAL-07), e a de remarcar avisa que **não vai junto** (RN-15 do
MOD-TAXI) — descobrir isso na porta de casa é o pior jeito de aprender a regra.

## O arnês de escrita cobre a agenda inteira

`tool/smoke_booking.dart` agora percorre marcar → ler o detalhe → remarcar → cancelar,
contra o servidor. É o que prova a forma das respostas, que é onde o gerador não alcança.

---

# O catálogo de estabelecimentos (2026-09-21)

A primeira tela pedia o slug digitado. Funciona e é ruim: o tutor conhece o petshop pelo
**nome da fachada**, não pelo endereço do site, e quem erra uma letra recebe "não
encontramos" sem saber se errou ou se o estabelecimento não usa o app.

**É a primeira linha de backend que o app exige.** Até aqui a propriedade do plano se
sustentava — o app era um cliente novo para uma API pronta. A lista quebra isso porque
não existia pergunta "quais petshops existem": `/portal/v1/tenant` valida um slug por
vez, e responde o mesmo 404 para slug errado, estabelecimento invisível e plano sem
Portal, justamente para ninguém poder sondar.

| Método e rota | Parâmetros | Devolve |
|---|---|---|
| `GET /public/v1/portal/tenants` | — (anônimo, **sem slug**) | `PortalDirectoryResponse` |

## A decisão, que não é técnica

A lista torna **enumerável quem usa o produto**. O que a contém é o critério: entram só
os estabelecimentos que **ligaram o Portal do cliente final** — ou seja, que já abriram
uma porta pública para os próprios clientes —, e o que desce é o que está na fachada:
nome, endereço do site, logo e cor. Nada de telefone, nada de endereço, nada de
operação; quem quiser a vitrine abre o site do estabelecimento, que é onde ela mora.

O critério é, palavra por palavra, o que `resolvePortalTenant` aplica: estado da conta
visível, plano com Portal e `portalEnabled` nas configurações. Um teste percorre a lista
inteira e exige 200 de `/portal/v1/tenant` para cada entrada — **a lista nunca oferece um
petshop que a tela seguinte responderia com 404 ou 403**, que seria pior do que não ter
lista.

## Três decisões de mecânica

- **Mora sob `/public/`, e não sob `/portal/v1`.** Todo caminho do Portal tem o tenant
  resolvido antes do roteamento, a partir do header do slug — e esta é a pergunta de
  quem ainda não sabe o slug. Pô-la no prefixo do Portal exigiria uma exceção no hook de
  sessão, que é o lugar onde exceção custa caro. Pelo mesmo motivo ela se registra fora
  do escopo de `registerModuleAuth`.
- **Tem teto por IP dentro do handler.** `/public/` está fora do balde geral porque em
  produção quem chama aquele prefixo é o servidor do Next, com um IP só (ver `app.ts`).
  Um app nativo quebra essa premissa: quem chama é o aparelho de cada tutor. O contador é
  o `withinRate` de `modules/portal/rate-limit.ts`, e não um segundo mecanismo — o
  `DISABLE_REDIS` da suíte já o troca por um em memória, então o teto é **exercitado** no
  teste em vez de sempre liberar.
- **Cache de cinco minutos, chave única.** O catálogo muda quando um estabelecimento
  entra, sai ou liga o Portal: evento de semana. É o cache que impede uma lista pública
  de virar uma varredura de banco por aparelho aberto.

## A tela

Lista rolável com filtro local — a lista inteira já está no aparelho, e ir ao servidor a
cada letra só somaria espera. O filtro ignora acento e caixa (quem procura "sao" precisa
achar "São").

O campo de endereço **continua existindo**, recolhido atrás de "Não achei o meu petshop",
para dois casos que a lista não cobre: o estabelecimento recém-criado que ainda está no
cache de cinco minutos, e o que prefere não aparecer em catálogo nenhum.

`truncated` vem na resposta e vira aviso na tela. Uma lista incompleta apresentada como
completa é o que faz o tutor concluir que o petshop dele não usa o app — e desistir.

## O que isto **não** resolve: a borda

O gateway **não é publicado** (decisão 1 do `infra/Caddyfile`): o cliente HTTP do
frontend é `server-only`, então a API atende só na rede interna. O comentário de lá
antecipa exatamente este caso — *"se um dia o MOD-PORTAL precisar de chamadas do browser,
aí sim se abre `api.{$APP_DOMAIN}` — e não antes"*. O app é essa hora, e vale para **todas**
as rotas que ele usa, não só para o catálogo. Em desenvolvimento nada disso aparece
porque o app fala com `10.0.2.2:3000` direto. **Publicar `api.` é pré-requisito do app em
produção, e é uma decisão de borda com peso próprio — não foi feita aqui.**

# Minha conta (etapa 6, 2026-09-21)

O Financeiro do Portal (MOD-PORTAL-08) no app: saldo, pacotes com crédito, extrato,
recibo e o extrato em papel. **Nenhuma rota nova** — as quatro da tabela já existiam,
servindo a web.

É a primeira tela do app que produz **arquivo** em vez de tela, e quase tudo o que ela
custou está aí.

## Os dois documentos não descem do mesmo jeito, e a diferença é do documento

| | recibo | extrato em PDF |
|---|---|---|
| o que a rota devolve | `{ number, status, issuedAt, url }` | os bytes do PDF |
| por quê | já está arquivado no R2, com retenção de cinco anos: há um **endereço** a assinar | não é arquivado (AC-04 de MOD-DOC-09): o PDF nasce na requisição e morre com ela |
| como o app entrega | `url_launcher`, no navegador do aparelho | grava no diretório temporário e passa à folha do sistema (`path_provider` + `share_plus`) |
| autenticação | nenhuma: a URL **é** a credencial, e vence | o token, como qualquer outra chamada |

`url` do recibo **pode voltar nula**, e isso não é erro: o PDF nasce depois do pagamento,
fora da transação, e um recibo em preparo tem número e não tem arquivo. A tela diz "está
sendo gerado" — um endereço morto seria a pior resposta a quem clicou para guardar o
comprovante.

O nome do arquivo do extrato vem do `content-disposition` da resposta
(`attachment; filename="extrato-2026-09-21.pdf"`), e `PortalClient.arquivo` o lê dali com
um nome de reserva para o caso de um intermediário o comer. Arquivo sem nome chega ao
e-mail como "documento" e não se acha depois.

## O que o app ganhou fora das telas

- **`PortalClient.arquivo`** — o primeiro GET cujo corpo não é JSON. Ele e o `_enviar`
  passam pelo mesmo `_responder`, que é o que garante que o download não nasça sem
  `authorization`, sem slug ou sem teto de tempo. O erro continua sendo `PortalError`: um
  403 nesta rota chega como `problem+json` igual a qualquer outra.
- **`lib/src/arquivos.dart`** — `abrirEndereco` e `entregarArquivo`, as duas saídas do app
  para fora do processo, como **variáveis de biblioteca**. Não é estilo: plugin nativo não
  existe no `flutter_test`, e um `getTemporaryDirectory()` na árvore de teste lança
  `MissingPluginException` — o arnês que substitui o emulador deixaria de alcançar
  justamente o botão que se quer conferir. Com o ponto de troca ali, o teste dubla a
  entrega e afirma **o que** o app mandou para fora. Mesmo desenho do `http_` injetado na
  `Sessao` e das `setXPort` do backend.
- **`deveEmCentavos` / `creditoEmCentavos`** em `dinheiro.dart` — `portalOwesCents` e
  `portalCreditCents` traduzidos. A convenção é **negativo para dívida**, e a leitura
  feita à mão já disse "Sem pendências" a quem devia, no Portal da web, passando por
  typecheck, lint e suíte. Nenhuma tela do app refaz a conta.
- **`TenantTime.dia`** — `dd/MM/yyyy` sem hora. O lançamento do extrato aconteceu num
  **dia**: três serviços do mesmo dia entram no mesmo instante, e mostrar `09:00` em todos
  diria uma precisão que o dado não tem.

## Divergências conscientes da web

- **A chave PIX tem botão de copiar.** Na web ela é texto selecionável, e o comentário de
  lá diz por quê: copiar exigiria JavaScript no cliente, e aquele cartão não tinha outro
  motivo para deixar de ser servidor. Num app não há esse custo — e a chave aleatória tem
  36 caracteres que ninguém digita no teclado do banco sem errar.
- **O chip do saldo em aberto é vermelho, e não da cor da marca.** Ele não está dizendo
  "financeiro" (que é verde no resto da tela): está dizendo "em aberto", a mesma coisa que
  o número embaixo. Com a cor da marca, o petshop de fachada azul teria a etiqueta azul ao
  lado de um valor vermelho.
- **A linha do menu chama-se "Minha conta"**, e não "Financeiro": o nome do módulo é
  vocabulário de quem opera o petshop.

## O que continua igual à web, de propósito

- Paginação **por página**, e não por cursor. O extrato ordena por `occurred_at`, que
  repete, e um cursor por data pularia ou repetiria linhas. O `total` diz quando parar de
  oferecer "Ver mais".
- O lançamento estornado **aparece riscado**, e sem recibo. Sumir com ele faz o tutor
  duvidar do extrato inteiro; oferecer comprovante do que foi desfeito é pior.
- **"Como pagar" só para quem deve.** Dar a chave PIX a quem está em dia é convidar a um
  pagamento sem destino, que alguém concilia à mão depois.
- **Não há botão de pagar**, e a ausência é o AC-05.

## O que o arnês guarda

`test/telas_financeiro_test.dart`, 10 casos. Os dois que valem por si: a convenção de
sinal (crédito não vira dívida, saldo zero é "Em dia") e as duas saídas para o sistema —
que o endereço aberto é o que o servidor assinou, e que a falha do PDF é dita **e** o
botão volta a responder. Um `finally` esquecido ali deixaria "Preparando…" para sempre,
sem erro nenhum no log.

`tool/smoke.dart` ganhou quatro passos, e o do PDF confere que os primeiros cinco bytes
são `%PDF-` — um `problem+json` de 200 bytes chegaria calado por aquele caminho.

As capturas: `16-minha-conta`, `16b-minha-conta-como-pagar` e `17-minha-conta-escuro`.

---

# O leva-e-traz (etapa 7, 2026-09-22)

O que ficou de fora do MVP de propósito — "pedir uma corrida é um ramo inteiro e custa
quase uma etapa" — entrou aqui. **Nenhuma rota nova no backend**: as duas que faltavam já
serviam a web.

| Método e rota | Parâmetros | Devolve |
|---|---|---|
| `GET /portal/v1/booking/taxi` | — | `PortalTaxiOffer` |
| `POST /portal/v1/booking` | `taxi: { pickup, dropoff }` | `AgendamentoCriado` com `taxi[]` e `taxiWarning` |

## A oferta não recebe pet, ainda que a rota viva sob `/booking`

O handler resolve o `tutorId` por `requireOwnScope` e **ignora a query**: o preço sai do
CEP do endereço primário do tutor, e nem o pet, nem os serviços, nem o horário o mudam. A
primeira versão do `PortalApi` mandava `?petId=`, que o servidor engolia em silêncio — e
um parâmetro ignorado é o que faz a tela acreditar numa dependência que não existe e
repetir a pergunta a cada troca de pet. A assinatura agora é `ofertaDeTaxi()`, sem
argumento, e a oferta é pedida **uma vez**, na abertura da tela.

Com `features.taxiEnabled` falso ela não é pedida de jeito nenhum: a rota responderia 402,
e a navegação lê `features`, nunca uma constante.

## Não existe pedido de corrida solto, e a razão é do domínio

No MOD-TAXI o dono da corrida é o agendamento (RN-01). Uma segunda porta criaria uma
segunda fila de aprovação além da que o agendamento online já pode ter, e o tutor
esperaria duas confirmações para uma tarde só. Por isso o leva-e-traz é um **cartão dentro
de "Marcar horário"** (`telas/agendar/leva_e_traz.dart`), entre os serviços e o dia, e não
uma linha no Início.

Ele aparece por dois motivos e some por um: aparece quando dá para pedir, e aparece quando
**não** dá por um motivo do próprio tutor (`NO_ADDRESS`, `OUT_OF_AREA`, `UNAVAILABLE`),
porque essa é a informação que ele precisa para resolver; some em `DISABLED` e
`NOT_CONFIGURED`, onde não é uma negativa e sim um serviço que não existe. O motivo viaja
como **enum** para a tela decidir isso, e como **texto** para nenhum cliente reescrever a
frase que a web já diz.

Ida e volta são duas linhas em `taxi_rides` (RN-02) e por isso duas caixas independentes,
com o preço **por perna** nas duas — somá-las na tela esconderia que quem pede só a ida
paga metade.

## As duas recusas são diferentes, e a diferença é quando elas acontecem

- **Falta de vaga** (`ERR_TAXI_007`, 409) acontece **antes** de o agendamento nascer, com
  o horário ainda livre. Chega com `alternativeStartsAt` — horários do mesmo dia que o
  servidor sondou —, ganha título próprio ("Sem vaga no leva-e-traz"; "Não deu para
  marcar" faria o tutor procurar o defeito no horário, que está livre) e um segundo
  caminho: **"Marcar sem o leva-e-traz"**, que reenvia o mesmo pedido com
  `_confirmar(comTaxi: false)`. Perder o banho por causa da van é o pior desfecho, e um
  toque é o que separa o tutor dele. É o `rodape` de `RecusaComAlternativas`.
- **Recusa por endereço** (AC-03) não derruba nada: o agendamento nasce e `taxiWarning`
  vem preenchido com a corrida vazia.

## O `taxiWarning` é lido no comprovante, e aqui isso diverge da web

Na web a confirmação navega para a lista, então o aviso precisa de um estado próprio para
**segurar** o tutor na tela. No app o desfecho já é uma tela que para: o agendamento
nasceu, o transporte não, e as duas notícias chegam juntas, que é a ordem em que
aconteceram. Passar batido daria ao tutor a certeza de que alguém vai buscar o pet.

## O total é somado pela tela, nos dois lugares

`totalCents` — na confirmação e na resposta do POST — é o do **atendimento**: a corrida é
outra linha, com preço próprio, e o servidor não as soma. A tela soma nos dois, e é isso
que faz o comprovante dizer o mesmo número que a confirmação dizia. Discriminado e nunca
embutido (AC-02): o transporte é o que o tutor pode tirar se o total surpreender.

## Duas divergências conscientes da web

- **As caixas dizem "Buscar em casa" e "Devolver em casa"**, e não "Buscar o pet em casa".
  A captura mostrou o rótulo quebrando em duas linhas ao dividir a largura de um celular
  de 390px com o preço; a descrição da seção já diz que se trata do pet.
- **O cartão vem antes do dia**, como na web, mas aqui isso custou um `aVista` em todo
  toque do arnês: a coluna cresceu de três cartões para quatro, e o seletor de dia, a
  grade e o botão de confirmar passaram a nascer abaixo da dobra. Toque fora da tela não
  erra — ele não acontece, e as duas capturas saem iguais, que é como isso se manifesta.

## O que o arnês guarda

`test/telas_agendar_test.dart` foi de 7 para 15 casos. Os que valem por si: a oferta
pedida **uma vez**; o módulo fora do plano que não gera chamada nenhuma; `DISABLED` que
não mostra o cartão e `NO_ADDRESS` que mostra; o pedido de uma perna só; e a van lotada
que termina com um agendamento sem `taxi` no corpo.

`tool/smoke_booking.dart` ganhou `--taxi`, atrás de um sinalizador porque cria corridas de
verdade no painel: ele lê a oferta, marca com as duas pernas e imprime `legLabel`,
`statusText` e a janela de cada corrida — a forma que nenhum dublê prova. A remarcação do
passo seguinte cancela as corridas (RN-15: remarcar não move a corrida) e o cancelamento
do fim derruba o resto sem cobrança (AC-06), o que torna o ensaio limpo. **Não foi rodado
contra o servidor vivo**: as rotas exigem um JWT do Clerk, e o vínculo de dev está na
conta real do usuário.

Capturas novas: `10b-leva-e-traz` e `13b-comprovante-total`; `12-confirmar` e
`13-comprovante` mudaram.

---

# Meus dados (etapa 8, 2026-09-23)

MOD-PORTAL-09 no app, e o que o deixa pronto para a revisão das lojas: a Apple (5.1.1(v))
e o Google Play exigem que o app que cria conta ofereça, **dentro dele**, o caminho para
pedir a exclusão. **Nenhuma rota nova no backend**, e os modelos já existiam — o gerador
cobre todo schema de `portal.ts`.

| Método e rota | Corpo | Devolve |
|---|---|---|
| `GET /portal/v1/me/data` | — | `PortalMeDataResponse` |
| `PATCH /portal/v1/me/data` | `UpdateOwnTutor` — os **dois** campos, nulos inclusive | `PortalMeDataResponse` |
| `POST /portal/v1/me/addresses` | `PortalAddressInput`, `semNulos` | `PortalMeDataResponse` (201) |
| `PATCH /portal/v1/me/addresses/:id` | `UpdatePortalAddress`, `semNulos` | `PortalMeDataResponse` |
| `POST /portal/v1/me/contact` | `PortalContactChange` | `PortalContactChangeResponse` (202) |
| `POST /portal/v1/me/contact/verify` | `PortalContactVerify` | `PortalMeDataResponse` |
| `GET /portal/v1/me/export/pdf` | — | bytes, com `content-disposition` |
| `GET /portal/v1/me/export` | — | JSON, **sem** `content-disposition` |
| `POST /portal/v1/me/deletion-request` | `PortalDeletionRequestInput`, `semNulos` | `PortalMeDataResponse` (201) |

**Toda escrita devolve a ficha inteira relida**, e a tela troca o estado por ela — nunca
remenda o que tinha. Nenhuma escrita é seguida de um `GET`.

## Três schemas, três sentidos de `null`

É a armadilha da etapa, e o que o arnês mais guarda:

- **Perfil** — `socialName` e `birthDate` são `.nullable()`: `null` é "apague", e vai
  sempre. Mesma exceção do `PATCH /pets/:id`.
- **Endereço** — `complement` e `accessNotes` são `.optional()`: `null` é **422**. O jeito
  de apagar é **string vazia**, que o serviço de endereços grava como `null`
  (`addresses/service.ts`). O formulário só manda `""` quando havia algo — não escreve na
  trilha uma mudança que ninguém fez.
- **Exclusão** — `reason` é `.optional()`: sem motivo, o corpo é `{}`.

## Divergências conscientes da web

- **A seta de voltar existe também com o desafio que veio do servidor.** Na web ela some
  quando o código pendente veio de `pendingContact`. Mas pedir um código novo consome o
  anterior (`contact-change.ts`), então não há o que proteger — e quem digitou o número
  errado e fechou o app ficaria preso a ele por dez minutos.
- **O desafio aberto aparece no cartão de Contato**, num aviso, e não só dentro da folha:
  no app a pessoa volta do WhatsApp para uma tela que não sabe o que ficou pela metade.
- **"Nome social"** no rótulo da ficha, e não "Como prefere ser chamado": a coluna de
  rótulos de `LinhaDeDado` tem 116px e a frase quebrava em duas linhas. A folha de edição
  mantém a frase longa, onde o rótulo tem a largura toda.
- **O JSON sai pela folha do sistema**, como o PDF. `entregarArquivo` passou a tirar o tipo
  do nome do arquivo, para não anunciar o JSON como PDF.

## O que ficou fora

As duas exportações não entraram no `tool/smoke.dart`: cada uma grava `tutor.exported`
na trilha, e um arnês que roda à toa não deve registrar um exercício do direito de acesso
que o titular não fez. O smoke lê só `GET /me/data`.

## O que o arnês guarda

`test/telas_meus_dados_test.dart`, 8 casos. O dublê **recusa `null`** nas rotas de endereço
com 422, como o servidor — um dublê que aceitasse qualquer corpo deixaria passar
exatamente o defeito que a etapa mais arrisca.

`ui/folha.dart` (`FolhaDeFormulario`, `RotuloDeCampo`, `DicaDeCampo`) nasceu aqui, da
construção que `editar_pet.dart` tem escrita à mão; as quatro folhas de Meus Dados a usam.
A edição do pet continua com a cópia própria.

Capturas novas: `18-meus-dados`, `18b-meus-dados-fim`, `18c-trocar-contato`,
`18d-endereco` e `19-meus-dados-escuro`.

---

# Avisos no celular — push (etapa 9, 2026-09-23)

Decisões do usuário: **o push vai junto** com a mensagem de WhatsApp/e-mail (não
substitui), e cobre agendamento, pet pronto, leva-e-traz e cobrança. Recibo, documentos,
códigos de acesso, resposta do agente e todo `MARKETING` ficam de fora.

**A conta do Firebase é da PetShop AI, e uma só**: o app é um só nas lojas. O FCM não tem
custo; o plano Spark basta.

## O desenho: carona na mensagem, não canal novo

O CLAUDE.md diz que o motor do MOD-NOTIF é a única saída do produto. O push respeita isso
sem virar um terceiro `MessageChannel`:

- **O texto** mora no catálogo, em `push: { title, body, abre }` de
  `packages/shared-types/src/messaging-seed.ts`. A lista de avisos **é** esse campo.
- **No enfileiramento** (`messages.ts`) ele é renderizado com as mesmas variáveis e
  gravado cifrado em `messages.push_title_encrypted`/`push_body_encrypted` (RN-14).
- **No despacho** (`dispatch.ts` → `push.ts`, `sendPushCompanion`) ele sai **depois** dos
  portões do tutor (conta parada, consentimento, supressão, óbito) e **antes** dos tetos
  de vazão, que protegem o número do petshop e não o celular do cliente. O aviso da van
  não espera o WhatsApp do petshop voltar.
- **`push_deliveries`** tem `(message_id, device_id)` único: a retentativa do despacho não
  repete o aviso. Falha do FCM **nunca** muda o status da mensagem.
- Mensagem absorvida por uma irmã (RN-08) perde o próprio aviso; vale o da irmã.

A tela bloqueada é lida por qualquer um: **a cobrança não diz o valor**, e um teste do
catálogo proíbe `financeiro.*` e `R$` no texto de push.

## Os aparelhos

| Método e rota | Corpo | Devolve |
|---|---|---|
| `POST /portal/v1/devices` | `PortalDevice` `{ token, platform }` | 204 |
| `DELETE /portal/v1/devices` | `PortalDeviceForget` `{ token }` — **no corpo**, não no caminho | 204 |

- A tabela `push_devices` é do MOD-NOTIF (`modules/messaging/devices.ts`); o Portal grava
  por `modules/portal/devices-port.ts`, a **sétima porta** do MOD-PORTAL.
- **Um aparelho, um dono, em todos os tenants**: `token_hash` é único global. O celular
  que passa a outra conta muda de dono, e a limpeza da linha antiga passa pelo cliente de
  manutenção, porque ela pode estar noutro tenant.
- `UNREGISTERED`/404 do FCM revoga o aparelho. `INVALID_ARGUMENT` **não**: é também a
  resposta a um payload malformado nosso, e revogaria a base inteira no dia de um defeito.
- A anonimização do tutor apaga os aparelhos na mesma transação.

## No app

- `lib/src/notificacoes.dart` — a interface `Avisos` e o ponto de troca `avisos`. O real
  **nunca lança**: sem `google-services.json`, `Firebase.initializeApp` falha e o app segue
  igual, sem push. É também por isso que os testes antigos não precisaram de dublê.
- `Sessao` registra o aparelho quando fica pronta **e** a permissão já foi concedida,
  reenvia a cada `onTokenRefresh` e o esquece em `sair()` **antes** de encerrar a sessão da
  Clerk — sem o token dela o `DELETE` seria recusado.
- **O pedido do sistema só sai de um toque**, no cartão "Receber avisos no celular" do
  Início. "Agora não" fica guardado no aparelho (`Armazenamento.avisosDispensados`). Meus
  dados tem a linha "Avisos no celular" com o estado e o caminho de volta.
- O toque leva a Meus agendamentos (`abre: agendamento`) ou Minha conta (`abre: conta`).
  Aviso de **outro petshop** não navega. Com o app aberto vira `SnackBar` com "Ver".
- **O `addPostFrameCallback` precisa de `scheduleFrame()`**: o aviso chega com o app
  parado, e sem quadro pedido o toque não levaria a lugar nenhum até o próximo toque na
  tela. O arnês de widget apanhou isso.

## Android

- `POST_NOTIFICATIONS` no manifesto (Android 13+), o ícone da barra é
  `@drawable/ic_launcher_mono`, e o canal `avisos` ("Avisos do petshop") é criado em
  `MainActivity.kt` — é o `channel_id` que o backend manda.
- O plugin `com.google.gms.google-services` só é aplicado **se** `android/app/google-services.json`
  existir. O arquivo pode ir para o git: é configuração de cliente, não segredo.

## Para ligar de verdade

1. Criar o projeto no Firebase (conta Google da empresa), adicionar o app Android
   `com.petshopai.petshop_tutor` e baixar o `google-services.json` para `app/android/app/`.
2. Em Configurações do projeto → Contas de serviço, gerar a chave privada e colocar no
   `.env.production` da VPS:
   `FCM_PROJECT_ID=<id do projeto>` e
   `FCM_SERVICE_ACCOUNT_JSON_B64=$(base64 -i chave.json | tr -d '\n')`.
3. `scripts/conferir-ambiente.sh` avisa quando faltam.
4. `flutter build apk --debug`, instalar num Android físico, entrar, tocar "Ativar avisos"
   e marcar um horário: a confirmação chega por WhatsApp **e** na tela.

## O que o arnês guarda

- Backend: `tests/messaging/push.test.ts` (9) e `tests/portal/devices.test.ts` (6);
  `messaging-seed.test.ts` com as regras do texto de push.
- App: `test/notificacoes_test.dart` (9), com o dublê de `Avisos`.

**Não verificado num aparelho**: depende do projeto Firebase, que ainda não existe.
