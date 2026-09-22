# petshop_tutor

O app do Portal do Tutor do PetShop AI. Flutter, Android e iOS.

O contrato do que o backend responde está em **`docs/app-flutter/contrato.md`**, na raiz
do repositório — é ele que se lê no lugar de varrer o Next.

## Rodar

O padrão de compilação é a **VPS**: sem argumento nenhum o app fala com
`https://api.petshop.officestecnologia.com.br`, que é o que faz um APK instalado num
aparelho qualquer funcionar em rede qualquer.

```bash
flutter run                                              # contra a VPS
flutter run --dart-define-from-file=dart_defines/local.json   # contra o seu Mac
```

`dart_defines/local.json` aponta para `http://10.0.2.2:3000` — como o emulador do Android
alcança o `localhost` da máquina. Num aparelho ligado por USB, troque pelo IP do Mac na
rede local.

Os padrões moram em `lib/src/config.dart`. Cleartext (`http://`) só funciona em
depuração: o manifesto de `android/app/src/debug/` traz o `usesCleartextTraffic`, e a
versão publicada nunca fala http.

## Conferir sem emulador

O emulador Android desta máquina é instável, e não é dele que a verificação depende. São
três arnêses de linha de comando, que usam as **classes do app**:

```bash
# lê: percorre as telas contra um servidor de verdade
dart run tool/smoke.dart <token> <slug> [baseUrl]

# entra: Clerk → renovar → apresentar ao Portal → vincular → sair
CLERK_PUBLISHABLE_KEY=pk_test_… \
  dart run tool/smoke_auth.dart <email> <codigo> <slug> [baseUrl]

# escreve: marca, remarca e cancela de VERDADE
dart run tool/smoke_booking.dart <token> <slug> [baseUrl] [--taxi]
```

`baseUrl` é opcional e vale `http://localhost:3000` quando omitido — de dentro do Mac não
há emulador no caminho. Para a VPS, passe
`https://api.petshop.officestecnologia.com.br`.

Numa instância de desenvolvimento do Clerk, um e-mail com `+clerk_test` aceita o código
fixo `424242`, o que torna a verificação repetível sem caixa de entrada.

## Testes

```bash
flutter analyze
flutter test
```

`test/telas_pets_test.dart` percorre o app **inteiro** — `Sessao`, navegação e
`CarregarDados` de produção — contra um `MockClient`. É ele que substitui o emulador, e
três coisas que ele custou estão registradas no contrato: a tela do teste precisa ter
forma de celular, `ensureVisible` em vez de `scrollUntilVisible`, e o cursor da paginação
vai na query e não no caminho.

## Os modelos são gerados

`lib/src/models/portal_models.dart` sai dos schemas Zod e **não se edita à mão**:

```bash
pnpm --filter @petshop/shared-types run gen:dart
```

A única classe escrita à mão é `lib/src/api/agendamento_criado.dart`: a resposta do
`POST /booking` é uma `interface` do TypeScript, não um schema, e o gerador não a alcança.
