import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/arquivos.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';
import 'package:petshop_tutor/src/telas/documentos/texto_do_termo.dart';

/// Meus documentos, percorrida sem emulador (MOD-DOC-10, MOD-DOC-07 e 08).
///
/// O que se guarda aqui: o endereço assinado é pedido **no toque**, e não na carga da
/// lista (é esse pedido que a trilha registra como download); o documento em preparo não
/// pede nada; e o aceite vai **sem corpo** e só depois de o texto ter sido aberto.
void main() {
  late List<String> chamadas;
  late List<Uri> abertos;
  late Map<String, dynamic> termos;

  http.Response json(Object corpo, [int status = 200]) => http.Response(
        jsonEncode(corpo),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  Future<void> abrirApp(WidgetTester tester, {String? urlDoDocumento = _url}) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    chamadas = [];
    abertos = [];
    termos = jsonDecode(jsonEncode(_termos)) as Map<String, dynamic>;

    final abrirDeVerdade = abrirEndereco;
    abrirEndereco = (endereco) async {
      abertos.add(endereco);
      return true;
    };
    addTearDown(() => abrirEndereco = abrirDeVerdade);

    final portal = MockClient((req) async {
      final rota = '${req.method} ${req.url.path}';
      chamadas.add(rota);

      switch (rota) {
        case 'GET /portal/v1/tenant':
          return json(_tenant);
        case 'GET /portal/v1/me':
          return json(_me);
        case 'GET /portal/v1/documents':
          return json(_documentos);
        case 'GET /portal/v1/documents/doc-1':
          return json({'url': urlDoDocumento, 'number': 'RX-2026/000014'});
        case 'GET /portal/v1/terms':
          return json(termos);
        case 'POST /portal/v1/terms/IMAGE_USE/accept':
          // O servidor não espera corpo; um app que mandasse a versão estaria
          // declarando o que só o servidor pode conferir.
          if (req.body.isNotEmpty) return json({'detail': 'corpo inesperado'}, 422);
          final termo = (termos['terms'] as List).last as Map<String, dynamic>;
          termo['accepted'] = true;
          termo['acceptedVersion'] = termo['version'];
          return http.Response('', 204);
        default:
          return json({'detail': 'rota nao dublada: $rota'}, 404);
      }
    });

    final clerk = ClerkFapi(
      host: 'exemplo.clerk.accounts.dev',
      armazenamento: CofreEmMemoria(),
      http_: MockClient((req) async => json({'jwt': 'token-de-teste'})),
    );

    final cofre = CofreEmMemoria();
    await cofre.gravarSlug('petshopteste');
    await cofre.gravarSessaoId('sess_1');

    await tester.pumpWidget(App(
      sessao: Sessao(armazenamento: cofre, clerk: clerk, http_: portal),
    ));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Meus Documentos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Meus Documentos'));
    await tester.pumpAndSettle();
  }

  testWidgets('o endereço é pedido no toque, e é ele que o navegador abre', (tester) async {
    await abrirApp(tester);

    expect(find.text('Receituário'), findsOneWidget);
    expect(find.text('Nº RX-2026/000014 · 18/09/2026 · Marley'), findsOneWidget);
    expect(find.text('em preparo'), findsOneWidget);
    expect(chamadas.where((c) => c.startsWith('GET /portal/v1/documents/')), isEmpty);

    await tester.tap(find.text('Receituário'));
    await tester.pumpAndSettle();

    expect(chamadas, contains('GET /portal/v1/documents/doc-1'));
    expect(abertos, [Uri.parse(_url)]);
  });

  testWidgets('o documento em preparo não pede endereço nenhum', (tester) async {
    await abrirApp(tester);

    await tester.tap(find.text('Nº REC-2026/000245'));
    await tester.pumpAndSettle();

    expect(chamadas.where((c) => c.startsWith('GET /portal/v1/documents/')), isEmpty);
    expect(abertos, isEmpty);
  });

  testWidgets('endereço nulo diz que está sendo gerado, e não abre nada', (tester) async {
    await abrirApp(tester, urlDoDocumento: null);

    await tester.tap(find.text('Receituário'));
    await tester.pumpAndSettle();

    expect(abertos, isEmpty);
    expect(find.textContaining('está sendo gerado'), findsOneWidget);
  });

  testWidgets('o aceite mora na folha do texto, vai sem corpo e a lista relê', (tester) async {
    await abrirApp(tester);

    final termo = find.text('Autorização de uso de imagem');
    await tester.ensureVisible(termo);
    await tester.pumpAndSettle();
    expect(find.text('Você aceitou a versão 1.0; há uma nova'), findsOneWidget);

    await tester.tap(termo);
    await tester.pumpAndSettle();
    expect(find.textContaining('fotos do meu pet', findRichText: true), findsOneWidget);

    await tester.tap(find.text('Li e aceito'));
    await tester.pumpAndSettle();

    expect(chamadas, contains('POST /portal/v1/terms/IMAGE_USE/accept'));
    expect(chamadas.where((c) => c == 'GET /portal/v1/terms').length, 2);
    expect(find.text('Aceito · versão 2.0'), findsOneWidget);
  });

  testWidgets('termo já aceito abre só para leitura', (tester) async {
    await abrirApp(tester);

    final termo = find.text('Aceito · versão 1.0');
    await tester.ensureVisible(termo);
    await tester.pumpAndSettle();
    await tester.tap(termo);
    await tester.pumpAndSettle();

    expect(find.text('Li e aceito'), findsNothing);
    expect(find.byType(BottomSheet), findsOneWidget);
  });

  group('blocosDoTermo — a tradução de parseTermBody', () {
    test('título, parágrafo que junta linhas, lista e negrito', () {
      final blocos = blocosDoTermo(
        '# Uso\r\nprimeira linha\nsegunda **forte** fim\n\n- um\n* dois\ndepois',
      );

      expect(blocos.map((b) => b.tipo), [
        TipoDeBloco.titulo,
        TipoDeBloco.paragrafo,
        TipoDeBloco.lista,
        TipoDeBloco.paragrafo,
      ]);
      expect(blocos[0].trechos.single.texto, 'Uso');
      expect(
        blocos[1].trechos.map((t) => (t.texto, t.negrito)),
        [('primeira linha segunda ', false), ('forte', true), (' fim', false)],
      );
      expect(blocos[2].itens.map((i) => i.single.texto), ['um', 'dois']);
      expect(blocos[3].trechos.single.texto, 'depois');
    });

    test('o que não é negrito passa inteiro, inclusive < e &', () {
      final blocos = blocosDoTermo('a < b & **c');
      expect(blocos.single.trechos.single.texto, 'a < b & **c');
    });

    test('o título sai em Title Case, com o negrito nos mesmos limites', () {
      final titulo = blocosDoTermo('## Das **condições de** pagamento').single;
      expect(
        titulo.trechos.map((t) => (t.texto, t.negrito)),
        [('Das ', false), ('Condições de', true), (' Pagamento', false)],
      );
    });
  });
}

const _url = 'https://r2.exemplo.com/docs/rx-14.pdf?assinatura=abc';

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
  'tutor': {'id': 'tutor-1', 'name': 'Mário Moraes', 'petsCount': 1, 'balanceCents': 0},
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};

const _documentos = {
  'documents': [
    {
      'id': 'doc-1',
      'kind': 'PRESCRIPTION',
      'number': 'RX-2026/000014',
      'issuedAt': '2026-09-18T14:30:00.000Z',
      'petName': 'Marley',
      'ready': true,
    },
    {
      'id': 'doc-3',
      'kind': 'RECEIPT',
      'number': 'REC-2026/000245',
      'issuedAt': null,
      'petName': null,
      'ready': false,
    },
  ],
};

const _termos = {
  'terms': [
    {
      'kind': 'SERVICE_LIABILITY',
      'title': 'Termo de responsabilidade',
      'version': '1.0',
      'body': 'O tutor declara que o animal está apto.',
      'accepted': true,
      'acceptedVersion': '1.0',
    },
    {
      'kind': 'IMAGE_USE',
      'title': 'Autorização de uso de imagem',
      'version': '2.0',
      'body': 'Autorizo publicar **fotos do meu pet**.',
      'accepted': false,
      'acceptedVersion': '1.0',
    },
  ],
};
