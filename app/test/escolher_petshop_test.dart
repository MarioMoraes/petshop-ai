import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// A primeira tela, depois que o campo de texto virou catálogo.
void main() {
  late List<String> chamadas;
  late List<String?> slugsEnviados;
  late List<Map<String, dynamic>> catalogo;
  late bool truncado;

  Future<void> abrirApp(WidgetTester tester) async {
    chamadas = [];
    slugsEnviados = [];
    truncado = false;
    catalogo = [
      _entrada('amigofiel', 'Amigo Fiel'),
      _entrada('saobernardo', 'São Bernardo Pet'),
      _entrada('zoopet', 'Zoo Pet'),
    ];

    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final portal = MockClient((req) async {
      final rota = '${req.method} ${req.url.path}';
      chamadas.add(rota);
      slugsEnviados.add(req.headers['x-petshop-tenant-slug']);

      switch (rota) {
        case 'GET /public/v1/portal/tenants':
          return _json({'tenants': catalogo, 'truncated': truncado});
        case 'GET /portal/v1/tenant':
          final slug = req.headers['x-petshop-tenant-slug'];
          if (catalogo.every((item) => item['slug'] != slug)) {
            return http.Response(
              jsonEncode({'code': 'ERR_PORTAL_001', 'detail': 'Estabelecimento não encontrado'}),
              404,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          return _json({
            'name': 'Amigo Fiel',
            'slug': slug,
            'logoUrl': null,
            'brandColor': '#E34A32',
            'portalEnabled': true,
          });
        default:
          return http.Response('{"detail":"rota nao dublada"}', 404,
              headers: {'content-type': 'application/json; charset=utf-8'});
      }
    });

    await tester.pumpWidget(App(
      sessao: Sessao(
        // Cofre vazio: ninguém escolheu petshop ainda, que é o estado desta tela.
        armazenamento: CofreEmMemoria(),
        clerk: ClerkFapi(
          host: 'exemplo.clerk.accounts.dev',
          armazenamento: CofreEmMemoria(),
          http_: MockClient((_) async => _json({'jwt': 'token-de-teste'})),
        ),
        http_: portal,
      ),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('abre com a lista, sem ninguém digitar nada', (tester) async {
    await abrirApp(tester);

    expect(find.text('Selecione Seu PetShop'), findsOneWidget);
    expect(find.text('Amigo Fiel'), findsOneWidget);
    expect(find.text('São Bernardo Pet'), findsOneWidget);
    expect(find.text('Zoo Pet'), findsOneWidget);

    // O catálogo é anterior à escolha: vai **sem** o header do slug.
    expect(chamadas.first, 'GET /public/v1/portal/tenants');
    expect(slugsEnviados.first, isNull);
  });

  testWidgets('o filtro ignora acento e caixa, e não vai ao servidor', (tester) async {
    await abrirApp(tester);
    final antes = chamadas.length;

    await tester.enterText(find.byType(TextField).first, 'sao');
    await tester.pumpAndSettle();

    expect(find.text('São Bernardo Pet'), findsOneWidget);
    expect(find.text('Amigo Fiel'), findsNothing);
    // Filtrar é local: a lista inteira já está no aparelho.
    expect(chamadas.length, antes);
  });

  testWidgets('o nome que não casa com nada diz o que fazer', (tester) async {
    await abrirApp(tester);
    await tester.enterText(find.byType(TextField).first, 'xyz');
    await tester.pumpAndSettle();

    expect(find.text('Nada com esse nome'), findsOneWidget);
  });

  testWidgets('tocar no petshop o adota e leva à tela de entrar', (tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Zoo Pet'));
    await tester.pumpAndSettle();

    expect(chamadas, contains('GET /portal/v1/tenant'));
    expect(slugsEnviados, contains('zoopet'));
    // Sem petshop escolhido não havia tela de entrada; agora há.
    expect(find.text('Selecione Seu PetShop'), findsNothing);
  });

  testWidgets('lista cortada avisa que está cortada', (tester) async {
    await abrirApp(tester);
    expect(find.textContaining('Há mais estabelecimentos'), findsNothing);

    truncado = true;
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();

    // Uma lista incompleta apresentada como completa é o que faz o tutor concluir que o
    // petshop dele não usa o app — e desistir.
    await tester.ensureVisible(find.textContaining('Há mais estabelecimentos'));
    expect(find.textContaining('Há mais estabelecimentos'), findsOneWidget);
  });

  // Sem a porta dos fundos, o catálogo vazio **não** tem saída dentro do app — então o
  // que a tela deve é dizer de quem depende o acesso, em vez de mandar digitar um
  // endereço que não tem mais onde ser digitado.
  testWidgets('catálogo vazio diz de quem depende o acesso', (tester) async {
    await abrirApp(tester);
    catalogo = [];
    // Puxar para atualizar refaz a busca com a resposta nova.
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();

    expect(find.text('Nenhum estabelecimento disponível'), findsOneWidget);
    expect(find.textContaining('fale com o seu'), findsOneWidget);
    expect(find.text('Não achei o meu petshop'), findsNothing);
  });
}

http.Response _json(Object corpo) => http.Response(
      jsonEncode(corpo),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Map<String, dynamic> _entrada(String slug, String nome) => {
      'slug': slug,
      'name': nome,
      'logoUrl': null,
      'brandColor': '#E34A32',
    };
