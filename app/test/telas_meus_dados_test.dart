import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/arquivos.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// Meus dados, percorrida sem emulador (MOD-PORTAL-09).
///
/// O que este arquivo guarda são **os corpos que o app manda**, mais do que o que a tela
/// mostra. Os schemas de escrita de Meus Dados discordam entre si sobre o que `null`
/// quer dizer: no perfil ele é "apague" e tem de ir; no endereço e no pedido de exclusão
/// ele é 422 e não pode ir — e o jeito de apagar o complemento é string vazia. Um dublê
/// que aceitasse qualquer corpo deixaria as três coisas erradas passarem verdes.
void main() {
  late List<String> chamadas;
  late Map<String, Map<String, dynamic>> corpos;
  late Map<String, dynamic> dados;
  late List<ArquivoDoPortal> entregues;

  void telaDeCelular(WidgetTester tester) {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }

  http.Response json(Object corpo, [int status = 200]) => http.Response(
        jsonEncode(corpo),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  Future<void> abrirApp(WidgetTester tester, {Map<String, dynamic>? pendente}) async {
    telaDeCelular(tester);
    chamadas = [];
    corpos = {};
    entregues = [];
    dados = jsonDecode(jsonEncode(_dados)) as Map<String, dynamic>;
    if (pendente != null) dados['pendingContact'] = pendente;

    final entregarDeVerdade = entregarArquivo;
    entregarArquivo = (arquivo, {Rect? origem}) async => entregues.add(arquivo);
    addTearDown(() => entregarArquivo = entregarDeVerdade);

    final portal = MockClient((req) async {
      final rota = '${req.method} ${req.url.path}';
      chamadas.add(rota);
      if (req.body.isNotEmpty) corpos[rota] = jsonDecode(req.body) as Map<String, dynamic>;

      switch (rota) {
        case 'GET /portal/v1/tenant':
          return json(_tenant);
        case 'GET /portal/v1/me':
          return json(_me);
        case 'GET /portal/v1/me/data':
          return json(dados);
        case 'PATCH /portal/v1/me/data':
          final corpo = corpos[rota]!;
          (dados['profile'] as Map)['socialName'] = corpo['socialName'];
          (dados['profile'] as Map)['birthDate'] = corpo['birthDate'];
          return json(dados);
        case 'PATCH /portal/v1/me/addresses/end-1':
          final corpo = corpos[rota]!;
          // O schema do servidor recusa `null` nestes campos — o dublê também.
          if (corpo.values.any((v) => v == null)) {
            return json({'detail': 'Dados inválidos'}, 422);
          }
          final endereco = (dados['addresses'] as List).first as Map<String, dynamic>;
          endereco.addAll(corpo);
          if (corpo['complement'] == '') endereco['complement'] = null;
          return json(dados);
        case 'POST /portal/v1/me/addresses':
          final corpo = corpos[rota]!;
          if (corpo.values.any((v) => v == null)) {
            return json({'detail': 'Dados inválidos'}, 422);
          }
          (dados['addresses'] as List).add({
            'id': 'end-2',
            'complement': null,
            'accessNotes': null,
            ...corpo,
          });
          return json(dados, 201);
        case 'POST /portal/v1/me/contact':
          return json({
            'changeId': '3f1c6a55-1111-4222-8333-444455556666',
            'field': corpos[rota]!['field'],
            'channel': 'WHATSAPP',
            'maskedTarget': '(11) 9****-4321',
            'expiresInMin': 10,
          }, 202);
        case 'POST /portal/v1/me/contact/verify':
          if (corpos[rota]!['code'] != '123456') {
            return json({'detail': 'Código inválido ou expirado.'}, 422);
          }
          (dados['profile'] as Map)['phoneMasked'] = '(11) 9****-4321';
          dados['pendingContact'] = null;
          return json(dados);
        case 'POST /portal/v1/me/deletion-request':
          dados['deletionRequest'] = {
            'id': '9a9a9a9a-1111-4222-8333-444455556666',
            'status': 'OPEN',
            'requestedAt': '2026-09-23T13:00:00.000Z',
            'dueAt': '2026-10-08T13:00:00.000Z',
            'respondedAt': null,
            'resolution': null,
          };
          return json(dados, 201);
        case 'GET /portal/v1/me/export/pdf':
          return http.Response.bytes(
            Uint8List.fromList('%PDF-1.4 dados'.codeUnits),
            200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="meus-dados-2026-09-23.pdf"',
            },
          );
        case 'GET /portal/v1/me/export':
          return json({'tutor': {'fullName': 'Mário Moraes'}});
        default:
          return json({'detail': 'rota nao dublada'}, 404);
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

    await tester.tap(find.text('Meus Dados'));
    await tester.pumpAndSettle();
  }

  /// O botão que grava, no rodapé da folha aberta.
  Future<void> tocarNaFolha(WidgetTester tester, String rotulo) async {
    final alvo = find.descendant(
      of: find.byType(BottomSheet),
      matching: find.text(rotulo),
    );
    await tester.ensureVisible(alvo);
    await tester.tap(alvo);
    await tester.pumpAndSettle();
  }

  testWidgets('do Início à ficha: dados, contato, endereço e o caminho da exclusão',
      (tester) async {
    await abrirApp(tester);

    expect(find.text('Mário Moraes'), findsOneWidget);
    expect(find.text('Marinho'), findsOneWidget);
    expect(find.text('***.598.588-**'), findsOneWidget);
    // Data de calendário, sem fuso: 12/04, e não 11/04.
    expect(find.text('12/04/1990'), findsOneWidget);
    expect(find.text('(11) 9****-8801'), findsOneWidget);
    expect(find.text('mario@exemplo.com'), findsOneWidget);
    await aVista(tester, find.text('Casa'));
    expect(find.text('Casa'), findsOneWidget);
    expect(find.text('Rua das Flores, 120 — Apto 42'), findsOneWidget);
    expect(find.text('Principal'), findsOneWidget);

    await aVista(tester, find.text('Pedir exclusão dos meus dados'));
    expect(find.text('Pedir exclusão dos meus dados'), findsOneWidget);

    // Uma chamada só abre a tela.
    expect(chamadas.where((c) => c.startsWith('GET /portal/v1/me/data')).length, 1);
  });

  testWidgets('limpar o nome social manda null — o "apague" — e a tela adota a resposta',
      (tester) async {
    await abrirApp(tester);

    await tester.tap(find.text('Editar'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Marinho'), '');
    await tocarNaFolha(tester, 'Salvar');

    final corpo = corpos['PATCH /portal/v1/me/data']!;
    expect(corpo.containsKey('socialName'), isTrue);
    expect(corpo['socialName'], isNull);
    // A data que não mudou vai também, e no formato de dia de calendário.
    expect(corpo['birthDate'], '1990-04-12');

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('Marinho'), findsNothing);
    expect(find.text('Dados salvos.'), findsOneWidget);
    // A tela trocou pela resposta, sem um segundo GET.
    expect(chamadas.where((c) => c == 'GET /portal/v1/me/data').length, 1);
  });

  testWidgets('trocar o telefone: código para o número novo, e só depois a ficha muda',
      (tester) async {
    await abrirApp(tester);

    await tester.tap(find.text('Alterar'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(of: find.byType(BottomSheet), matching: find.byType(TextField)),
      '11987654321',
    );
    await tester.pump();
    await tocarNaFolha(tester, 'Enviar código');

    expect(corpos['POST /portal/v1/me/contact'], {'field': 'PHONE', 'value': '11987654321'});
    expect(find.text('Confirme o código'), findsOneWidget);
    expect(
      find.text('Enviamos um código para (11) 9****-4321. Ele vale por 10 minutos.'),
      findsOneWidget,
    );
    // Nada mudou na ficha ainda.
    expect(chamadas, isNot(contains('POST /portal/v1/me/contact/verify')));

    // Código errado: a frase do servidor, e a folha continua aberta.
    final campo =
        find.descendant(of: find.byType(BottomSheet), matching: find.byType(TextField));
    await tester.enterText(campo, '000000');
    await tester.pump();
    await tocarNaFolha(tester, 'Confirmar');
    expect(find.text('Código inválido ou expirado.'), findsOneWidget);

    await tester.enterText(campo, '123456');
    await tester.pump();
    await tocarNaFolha(tester, 'Confirmar');

    expect(corpos['POST /portal/v1/me/contact/verify']!['changeId'],
        '3f1c6a55-1111-4222-8333-444455556666');
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('(11) 9****-4321'), findsOneWidget);
  });

  testWidgets('o desafio que ficou aberto abre direto no código, e dá para voltar',
      (tester) async {
    await abrirApp(tester, pendente: {
      'id': '3f1c6a55-1111-4222-8333-444455556666',
      'field': 'EMAIL',
      'maskedTarget': 'n***@exemplo.com',
      'expiresAt': '2026-09-23T13:10:00.000Z',
    });

    expect(find.textContaining('Há um código esperando confirmação'), findsOneWidget);
    await tester.tap(find.text('Confirmar'));
    await tester.pumpAndSettle();

    expect(find.text('Confirme o código'), findsOneWidget);
    expect(find.textContaining('n***@exemplo.com. Ele vale'), findsOneWidget);

    // A seta devolve ao valor — com o e-mail escolhido, que era o do desafio.
    await tester.tap(find.descendant(
      of: find.byType(BottomSheet),
      matching: find.byTooltip('Voltar'),
    ));
    await tester.pumpAndSettle();
    expect(find.text('E-mail novo'), findsOneWidget);
  });

  testWidgets('apagar o complemento manda string vazia, nunca null', (tester) async {
    await abrirApp(tester);

    await aVista(tester, find.text('Rua das Flores, 120 — Apto 42'));
    await tester.tap(find.text('Rua das Flores, 120 — Apto 42'));
    await tester.pumpAndSettle();
    expect(find.text('Corrigir endereço'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Apto 42'), '');
    await tocarNaFolha(tester, 'Salvar');

    final corpo = corpos['PATCH /portal/v1/me/addresses/end-1']!;
    expect(corpo['complement'], '');
    expect(corpo.values.where((v) => v == null), isEmpty);
    expect(corpo['zipCode'], '01310100');
    // Sem coordenadas — nem escondidas.
    expect(corpo.containsKey('latitude'), isFalse);

    expect(find.byType(BottomSheet), findsNothing);
    await aVista(tester, find.text('Rua das Flores, 120'));
    expect(find.text('Rua das Flores, 120'), findsOneWidget);
  });

  testWidgets('endereço novo sem complemento não manda a chave', (tester) async {
    await abrirApp(tester);

    await aVista(tester, find.text('Adicionar'));
    await tester.tap(find.text('Adicionar'));
    await tester.pumpAndSettle();
    expect(find.text('Novo endereço'), findsOneWidget);

    /// Os campos na ordem em que a folha os desenha. Pelo rótulo não dá: o rótulo e o
    /// campo são irmãos na mesma coluna, e o ancestral comum é o formulário inteiro.
    const ordem = [
      'Apelido', 'CEP', 'Rua', 'Número', 'Complemento', 'Bairro', 'Cidade', 'UF',
    ];
    Future<void> preencher(String rotulo, String valor) async {
      final campo = find
          .descendant(of: find.byType(BottomSheet), matching: find.byType(TextField))
          .at(ordem.indexOf(rotulo));
      await tester.ensureVisible(campo);
      await tester.enterText(campo, valor);
      await tester.pump();
    }

    await preencher('Apelido', 'Trabalho');
    await preencher('CEP', '04538133');
    await preencher('Rua', 'Avenida Faria Lima');
    await preencher('Número', '3500');
    await preencher('Bairro', 'Itaim Bibi');
    await preencher('Cidade', 'São Paulo');
    await preencher('UF', 'sp');
    await tocarNaFolha(tester, 'Salvar');

    final corpo = corpos['POST /portal/v1/me/addresses']!;
    expect(corpo.containsKey('complement'), isFalse);
    expect(corpo.containsKey('accessNotes'), isFalse);
    expect(corpo['zipCode'], '04538133');
    expect(corpo['state'], 'SP');
    await aVista(tester, find.text('Trabalho'));
    expect(find.text('Trabalho'), findsOneWidget);
  });

  testWidgets('o pedido de exclusão sem motivo vai vazio, e a tela diz em análise',
      (tester) async {
    await abrirApp(tester);

    await aVista(tester, find.text('Pedir exclusão dos meus dados'));
    await tester.tap(find.text('Pedir exclusão dos meus dados'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Nada é apagado agora.'), findsOneWidget);

    await tocarNaFolha(tester, 'Enviar pedido');

    expect(corpos['POST /portal/v1/me/deletion-request'], isEmpty);
    await aVista(tester, find.text('Em análise'));
    expect(find.text('Em análise'), findsOneWidget);
    expect(find.textContaining('responde até 08/10/2026'), findsOneWidget);
    expect(find.text('Pedir exclusão dos meus dados'), findsNothing);
  });

  testWidgets('a cópia desce em PDF e em JSON, e vai para a folha do sistema',
      (tester) async {
    await abrirApp(tester);

    await aVista(tester, find.text('Baixar em PDF'));
    await tester.tap(find.text('Baixar em PDF'));
    await tester.pumpAndSettle();
    expect(entregues.single.nome, 'meus-dados-2026-09-23.pdf');
    expect(String.fromCharCodes(entregues.single.bytes.take(5)), '%PDF-');

    await tester.tap(find.textContaining('Baixar em JSON'));
    await tester.pumpAndSettle();
    expect(entregues.last.nome, endsWith('.json'));
    expect(jsonDecode(utf8.decode(entregues.last.bytes)), {
      'tutor': {'fullName': 'Mário Moraes'},
    });
  });
}

Future<void> aVista(WidgetTester tester, Finder alvo) async {
  if (alvo.evaluate().isEmpty) {
    await tester.scrollUntilVisible(alvo, 260, scrollable: find.byType(Scrollable).first);
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
    'balanceCents': 0,
  },
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};

const _dados = {
  'profile': {
    'fullName': 'Mário Moraes',
    'socialName': 'Marinho',
    'displayName': 'Marinho',
    'cpfMasked': '***.598.588-**',
    'cnpjMasked': null,
    'phoneMasked': '(11) 9****-8801',
    'email': 'mario@exemplo.com',
    'birthDate': '1990-04-12',
  },
  'addresses': [
    {
      'id': 'end-1',
      'label': 'Casa',
      'zipCode': '01310100',
      'street': 'Rua das Flores',
      'number': '120',
      'complement': 'Apto 42',
      'district': 'Bela Vista',
      'city': 'São Paulo',
      'state': 'SP',
      'accessNotes': null,
      'isPrimary': true,
    },
  ],
  'pendingContact': null,
  'deletionRequest': null,
};
