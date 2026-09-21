import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/arquivos.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// Minha conta, percorrida sem emulador (MOD-PORTAL-08).
///
/// Duas coisas aqui não existem nas outras telas, e são as que este arquivo guarda:
///
/// 1. **A convenção de sinal do saldo.** Negativo é dívida. A leitura feita à mão já
///    disse "Sem pendências" a quem devia, no Portal da web, e passou por typecheck,
///    lint e suíte — é um defeito que só uma afirmação sobre o texto da tela apanha.
/// 2. **As duas saídas para o sistema operacional.** O recibo abre um endereço e o
///    extrato entrega um arquivo, e as duas coisas são plugin nativo, que não existe no
///    `flutter_test`. `abrirEndereco` e `entregarArquivo` são dublados aqui, e é o que
///    permite afirmar *o que* o app mandou para fora — que é o que importa.
void main() {
  late List<String> chamadas;
  late Map<String, dynamic> conta;
  late Map<String, dynamic> recibo;
  late int? recusaDoRecibo;
  late bool recusaDoPdf;

  /// O que o app mandou para fora do processo.
  late List<Uri> abertos;
  late List<ArquivoDoPortal> entregues;

  /// O `pt_BR` separa o símbolo do número com espaço inquebrável — ver `dinheiro.dart`.
  String r(String valor) => 'R\$ $valor';

  void telaDeCelular(WidgetTester tester) {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }

  Future<void> abrirApp(WidgetTester tester) async {
    telaDeCelular(tester);
    chamadas = [];
    conta = Map<String, dynamic>.from(_conta);
    recibo = Map<String, dynamic>.from(_recibo);
    recusaDoRecibo = null;
    recusaDoPdf = false;
    abertos = [];
    entregues = [];

    // Os dublês das duas saídas, e a devolução do que havia: são variáveis de
    // biblioteca, e um teste que as deixasse trocadas contaminaria o arquivo seguinte.
    final abrirDeVerdade = abrirEndereco;
    final entregarDeVerdade = entregarArquivo;
    abrirEndereco = (endereco) async {
      abertos.add(endereco);
      return true;
    };
    entregarArquivo = (arquivo, {Rect? origem}) async => entregues.add(arquivo);
    addTearDown(() {
      abrirEndereco = abrirDeVerdade;
      entregarArquivo = entregarDeVerdade;
    });

    final portal = MockClient((req) async {
      chamadas.add('${req.method} ${req.url.path}'
          '${req.url.query.isEmpty ? '' : '?${req.url.query}'}');
      Map<String, dynamic>? corpo;

      switch ('${req.method} ${req.url.path}') {
        case 'GET /portal/v1/tenant':
          corpo = _tenant;
        case 'GET /portal/v1/me':
          corpo = _me;
        case 'GET /portal/v1/finance':
          corpo = conta;
        case 'GET /portal/v1/finance/statement':
          // A página vai na **query**, não no caminho. Dublar por caminho devolveria a
          // primeira de novo, e a tela pareceria certa repetindo lançamentos.
          corpo = switch (req.url.queryParameters['page']) {
            null || '1' => _extrato1,
            '2' => _extrato2,
            _ => null,
          };
          if (corpo == null) {
            return http.Response('{"detail":"página inexistente"}', 404,
                headers: {'content-type': 'application/json; charset=utf-8'});
          }
        case 'GET /portal/v1/finance/statement/pdf':
          if (recusaDoPdf) {
            // O Gotenberg fora do ar é a falha real desta rota, e ela responde
            // `problem+json` como qualquer outra — é o que o download precisa ler.
            return http.Response('{"detail":"não foi possível gerar o extrato"}', 503,
                headers: {'content-type': 'application/json; charset=utf-8'});
          }
          // Bytes, e não JSON: é a razão de `PortalClient.arquivo` existir.
          return http.Response.bytes(
            Uint8List.fromList('%PDF-1.4 extrato'.codeUnits),
            200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="extrato-2026-09-21.pdf"',
            },
          );
        case 'GET /portal/v1/finance/receipts/pay-1':
          if (recusaDoRecibo != null) {
            return http.Response('{"detail":"não foi possível abrir o recibo"}',
                recusaDoRecibo!,
                headers: {'content-type': 'application/json; charset=utf-8'});
          }
          corpo = recibo;
        default:
          return http.Response('{"detail":"rota nao dublada"}', 404,
              headers: {'content-type': 'application/json; charset=utf-8'});
      }

      return http.Response(jsonEncode(corpo), 200,
          headers: {'content-type': 'application/json'});
    });

    final clerk = ClerkFapi(
      host: 'exemplo.clerk.accounts.dev',
      armazenamento: CofreEmMemoria(),
      http_: MockClient((req) async => http.Response(
            jsonEncode({'jwt': 'token-de-teste'}),
            200,
            headers: {'content-type': 'application/json'},
          )),
    );

    final cofre = CofreEmMemoria();
    await cofre.gravarSlug('petshopteste');
    await cofre.gravarSessaoId('sess_1');

    await tester.pumpWidget(App(
      sessao: Sessao(armazenamento: cofre, clerk: clerk, http_: portal),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> entrarNaConta(WidgetTester tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Minha conta'));
    await tester.pumpAndSettle();
  }

  testWidgets('do Início à conta em aberto, com saldo, pacote e como pagar',
      (tester) async {
    await entrarNaConta(tester);

    // O saldo guardado é **negativo** (−18000), e a tela diz dívida.
    expect(find.text('EM ABERTO'), findsOneWidget);
    expect(find.text(r('180,00')), findsOneWidget);
    expect(
      find.text('O lançamento mais antigo em aberto é de 14/08/2026.'),
      findsOneWidget,
    );

    // O pacote, com a data de expiração dita desde já — e não só na semana do
    // vencimento.
    expect(find.text('Banho — 4 sessões'), findsOneWidget);
    expect(find.text('2 créditos restantes'), findsOneWidget);
    expect(find.text('Expira em 12/12/2026.'), findsOneWidget);

    // Os lançamentos, com o sinal que veio do servidor.
    expect(find.text('Banho e tosa'), findsOneWidget);
    expect(find.text('−${r('180,00')}'), findsOneWidget);
    expect(find.text('Pagamento recebido'), findsOneWidget);
    expect(find.text('+${r('90,00')}'), findsOneWidget);

    // As duas chamadas saíram juntas, e são duas — não uma por cartão.
    expect(chamadas.where((c) => c.startsWith('GET /portal/v1/finance')).length, 2);

    // "Como pagar" só existe para quem deve, e traz o caminho real.
    await aVista(tester, find.text('Como pagar'));
    expect(find.text('Chave PIX'), findsOneWidget);
    expect(find.text('petshopteste@exemplo.com.br'), findsOneWidget);
    expect(find.text('Seg a Sex: 08:00 às 18:00'), findsOneWidget);
  });

  testWidgets('crédito não vira dívida, e quem está em dia não vê como pagar',
      (tester) async {
    await abrirApp(tester);
    // O saldo **positivo** é crédito. Era esta leitura que o Portal da web errava.
    conta['balanceCents'] = 4500;
    conta['openDebitsCents'] = 0;
    conta['oldestOpenDebitAt'] = null;

    await tester.tap(find.text('Minha conta'));
    await tester.pumpAndSettle();

    expect(find.text('EM ABERTO'), findsNothing);
    expect(find.text('SUA CONTA'), findsOneWidget);
    expect(find.text(r('45,00')), findsOneWidget);
    expect(
      find.text('Este valor entra como desconto no seu próximo atendimento.'),
      findsOneWidget,
    );

    // Sem dívida não há chave PIX: pagamento sem destino é conciliação à mão depois.
    expect(find.text('Como pagar'), findsNothing);
    expect(find.text('Chave PIX'), findsNothing);
  });

  testWidgets('saldo zero é "Em dia", e não um valor', (tester) async {
    await abrirApp(tester);
    conta['balanceCents'] = 0;
    conta['openDebitsCents'] = 0;
    conta['oldestOpenDebitAt'] = null;

    await tester.tap(find.text('Minha conta'));
    await tester.pumpAndSettle();

    expect(find.text('Em dia'), findsOneWidget);
    expect(find.text('Nenhum valor em aberto por aqui.'), findsOneWidget);
  });

  testWidgets('"Ver mais" pede a página seguinte e não repete a atual',
      (tester) async {
    await entrarNaConta(tester);

    await aVista(tester, find.text('Ver mais'));
    await tester.tap(find.text('Ver mais'));
    await tester.pumpAndSettle();

    expect(chamadas.contains('GET /portal/v1/finance/statement?page=2&limit=10'), isTrue);
    expect(find.text('Taxa de cancelamento'), findsOneWidget);
    // O que já estava continua lá, uma vez só.
    expect(find.text('Banho e tosa'), findsOneWidget);
    expect(find.text('Pagamento recebido'), findsOneWidget);

    // A terceira página não existe: acabaram os lançamentos, e o botão some.
    expect(find.text('Ver mais'), findsNothing);
  });

  testWidgets('o recibo existe só no pagamento, e nunca no estornado',
      (tester) async {
    await entrarNaConta(tester);

    // Um pagamento, um recibo. O débito não tem `paymentId`.
    expect(find.text('Baixar recibo'), findsOneWidget);

    await aVista(tester, find.text('Ver mais'));
    await tester.tap(find.text('Ver mais'));
    await tester.pumpAndSettle();

    // A linha estornada **tem** `paymentId` e continua sem recibo: o que foi desfeito
    // não tem comprovante que valha.
    expect(find.text('Taxa de cancelamento'), findsOneWidget);
    expect(find.text('Baixar recibo'), findsOneWidget);
  });

  testWidgets('tocar no recibo abre o endereço que o servidor assinou',
      (tester) async {
    await entrarNaConta(tester);

    await aVista(tester, find.text('Baixar recibo'));
    await tester.tap(find.text('Baixar recibo'));
    await tester.pumpAndSettle();

    expect(chamadas.contains('GET /portal/v1/finance/receipts/pay-1'), isTrue);
    // O endereço aberto é o da resposta — a assinatura não é montada pelo app.
    expect(abertos.single.toString(), 'https://bucket.exemplo/recibo-1.pdf?assinatura=x');
  });

  testWidgets('recibo sem arquivo é "em preparo", e não um erro', (tester) async {
    await entrarNaConta(tester);
    // O PDF nasce depois do pagamento, fora da transação: há número e não há arquivo.
    recibo['url'] = null;

    await aVista(tester, find.text('Baixar recibo'));
    await tester.tap(find.text('Baixar recibo'));
    await tester.pumpAndSettle();

    expect(
      find.text('O recibo está sendo gerado. Tente de novo em alguns instantes.'),
      findsOneWidget,
    );
    expect(abertos, isEmpty);
  });

  testWidgets('o 404 do recibo alheio chega como falha, sem dizer que ele existe',
      (tester) async {
    await entrarNaConta(tester);
    recusaDoRecibo = 404;

    await aVista(tester, find.text('Baixar recibo'));
    await tester.tap(find.text('Baixar recibo'));
    await tester.pumpAndSettle();

    expect(find.text('não foi possível abrir o recibo'), findsOneWidget);
    expect(abertos, isEmpty);
  });

  testWidgets('o extrato em PDF desce em bytes e vai para a folha do sistema',
      (tester) async {
    await entrarNaConta(tester);

    await aVista(tester, find.text('Baixar extrato em PDF'));
    await tester.tap(find.text('Baixar extrato em PDF'));
    await tester.pumpAndSettle();

    expect(chamadas.contains('GET /portal/v1/finance/statement/pdf'), isTrue);
    final arquivo = entregues.single;
    expect(utf8.decode(arquivo.bytes), '%PDF-1.4 extrato');
    // O nome vem do `content-disposition`, e não do padrão de quem chamou.
    expect(arquivo.nome, 'extrato-2026-09-21.pdf');
  });

  testWidgets('a falha do extrato em PDF é dita, e o botão volta a responder',
      (tester) async {
    await entrarNaConta(tester);
    recusaDoPdf = true;

    await aVista(tester, find.text('Baixar extrato em PDF'));
    await tester.tap(find.text('Baixar extrato em PDF'));
    await tester.pumpAndSettle();

    // O texto do `problem+json` já foi escrito para o cliente final: ele atravessa.
    expect(find.text('não foi possível gerar o extrato'), findsOneWidget);
    expect(entregues, isEmpty);

    // E o botão sai da espera. Um `finally` esquecido aqui deixaria "Preparando…" para
    // sempre, sem erro nenhum no log — o botão que não volta é o defeito desta forma.
    expect(find.text('Preparando…'), findsNothing);
    expect(find.text('Baixar extrato em PDF'), findsOneWidget);
    expect(
      tester
          .widget<OutlinedButton>(find.ancestor(
            of: find.text('Baixar extrato em PDF'),
            matching: find.byType(OutlinedButton),
          ))
          .onPressed,
      isNotNull,
    );

    // E tentar de novo funciona: a falha não deixou estado preso.
    recusaDoPdf = false;
    await tester.tap(find.text('Baixar extrato em PDF'));
    await tester.pumpAndSettle();
    expect(entregues.single.nome, 'extrato-2026-09-21.pdf');
  });
}

/// Rola até o alvo antes de garantir a visibilidade.
///
/// `ensureVisible` sozinho estoura com "Bad state: No element" no fim de uma tela longa:
/// o `cacheExtent` do `ListView` constrói além do que se vê, mas não até o fim.
Future<void> aVista(WidgetTester tester, Finder alvo) async {
  if (alvo.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      alvo,
      260,
      scrollable: find.byType(Scrollable).first,
    );
  }
  await tester.ensureVisible(alvo);
  await tester.pumpAndSettle();
}

const _tenant = {
  'name': 'PetShop Teste',
  'slug': 'petshopteste',
  'logoUrl': null,
  'brandColor': '#E34A32',
  'portalEnabled': true,
};

const _me = {
  'tenant': {
    'name': 'PetShop Teste',
    'slug': 'petshopteste',
    'logoUrl': null,
    'brandColor': '#E34A32',
    'timezone': 'America/Sao_Paulo',
  },
  'tutor': {
    'id': 'tutor-1',
    'name': 'Mário Moraes',
    'petsCount': 1,
    'balanceCents': -18000,
  },
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};

/// **Negativo é dívida** — a convenção da plataforma, e a razão de este arquivo existir.
const _conta = {
  'balanceCents': -18000,
  'openDebitsCents': 18000,
  'oldestOpenDebitAt': '2026-08-14T13:00:00.000Z',
  'packages': [
    {
      'id': '3f1c8b2e-0000-4000-8000-000000000001',
      'name': 'Banho — 4 sessões',
      'petName': 'Marley',
      'creditsTotal': 4,
      'creditsRemaining': 2,
      'expiresAt': '2026-12-12T15:00:00.000Z',
      'expiringSoon': false,
    },
  ],
  'howToPay': {
    'pixKey': 'petshopteste@exemplo.com.br',
    'phone': null,
    'whatsapp': '(11) 99999-0000',
    'hours': [
      {'label': 'Seg a Sex', 'value': '08:00 às 18:00'},
    ],
  },
  'timezone': 'America/Sao_Paulo',
};

const _extrato1 = {
  'entries': [
    {
      'id': '3f1c8b2e-0000-4000-8000-000000000011',
      'occurredAt': '2026-09-14T13:00:00.000Z',
      'description': 'Pagamento recebido',
      'amountCents': 9000,
      'category': 'PAYMENT',
      'petName': null,
      'reversed': false,
      'paymentId': 'pay-1',
    },
    {
      'id': '3f1c8b2e-0000-4000-8000-000000000012',
      'occurredAt': '2026-08-14T13:00:00.000Z',
      'description': 'Banho e tosa',
      'amountCents': -18000,
      'category': 'SERVICE',
      'petName': 'Marley',
      'reversed': false,
      'paymentId': null,
    },
  ],
  'page': 1,
  'limit': 10,
  'total': 3,
  'balanceCents': -18000,
  'timezone': 'America/Sao_Paulo',
};

/// O estornado, que aparece **riscado** e sem recibo — sumir com ele faria o tutor
/// duvidar do extrato inteiro.
const _extrato2 = {
  'entries': [
    {
      'id': '3f1c8b2e-0000-4000-8000-000000000013',
      'occurredAt': '2026-07-02T13:00:00.000Z',
      'description': 'Taxa de cancelamento',
      'amountCents': -5000,
      'category': 'FEE',
      'petName': 'Marley',
      'reversed': true,
      'paymentId': 'pay-9',
    },
  ],
  'page': 2,
  'limit': 10,
  'total': 3,
  'balanceCents': -18000,
  'timezone': 'America/Sao_Paulo',
};

const _recibo = {
  'number': 'REC-2026-000123',
  'status': 'ISSUED',
  'issuedAt': '2026-09-14T13:05:00.000Z',
  'url': 'https://bucket.exemplo/recibo-1.pdf?assinatura=x',
};
