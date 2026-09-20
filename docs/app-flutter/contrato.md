# O contrato do app do tutor

Este arquivo existe para que as telas do app sejam escritas **sem reler o Next**. Ele é
o resumo verificado do que `/portal/v1` responde e do que o app precisa mandar. Tudo
aqui foi medido contra o backend em execução em 2026-09-20, não deduzido da leitura.

A referência viva continua sendo `backend/app/src/modules/portal/routes.ts` e
`packages/shared-types/src/portal.ts` — mas só se abre uma delas quando este arquivo não
responder.

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
