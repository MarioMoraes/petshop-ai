import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';
import 'package:petshop_tutor/src/notificacoes.dart';

/// Os avisos no celular (etapa 9 — push), sem Firebase e sem emulador.
///
/// O que se guarda aqui é o **ciclo do aparelho**: ele é registrado quando há sessão e
/// permissão, reenviado quando o token troca, e esquecido ao sair — **antes** de a sessão
/// acabar, porque o esquecimento precisa do token da Clerk. Errar a ordem não dá erro em
/// lugar nenhum: o próximo tutor a entrar naquele celular recebe os avisos do anterior.
void main() {
  late List<String> chamadas;
  late Map<String, Map<String, dynamic>> corpos;
  late _AvisosDeTeste fake;
  late CofreEmMemoria cofre;

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

  Future<void> abrirApp(
    WidgetTester tester, {
    PermissaoDeAvisos permissao = PermissaoDeAvisos.concedida,
    AvisoTocado? inicial,
  }) async {
    telaDeCelular(tester);
    chamadas = [];
    corpos = {};
    fake = _AvisosDeTeste(permissao: permissao, inicial: inicial);
    final real = avisos;
    avisos = fake;
    addTearDown(() {
      avisos = real;
      fake.fechar();
    });

    final portal = MockClient((req) async {
      final rota = '${req.method} ${req.url.path}';
      // O esquecimento só vale com a sessão ainda viva: sem o token, o servidor recusaria
      // e o aparelho continuaria desta ficha.
      chamadas.add(req.headers['authorization'] == null ? '$rota (sem token)' : rota);
      if (req.body.isNotEmpty) corpos[rota] = jsonDecode(req.body) as Map<String, dynamic>;

      return switch (rota) {
        'GET /portal/v1/tenant' => json(_tenant),
        'GET /portal/v1/me' => json(_me),
        'POST /portal/v1/devices' || 'DELETE /portal/v1/devices' => http.Response('', 204),
        'GET /portal/v1/appointments' => json({
            'upcoming': const [],
            'past': const [],
            'nextCursor': null,
            'timezone': 'America/Sao_Paulo',
          }),
        _ => json({'detail': 'rota nao dublada'}, 404),
      };
    });

    final clerk = ClerkFapi(
      host: 'exemplo.clerk.accounts.dev',
      armazenamento: CofreEmMemoria(),
      http_: MockClient((req) async => json({'jwt': 'token-de-teste'})),
    );

    cofre = CofreEmMemoria();
    await cofre.gravarSlug('petshopteste');
    await cofre.gravarSessaoId('sess_1');

    await tester.pumpWidget(App(
      sessao: Sessao(armazenamento: cofre, clerk: clerk, http_: portal),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('com permissão, o aparelho é registrado ao entrar, e de novo quando o token troca',
      (tester) async {
    await abrirApp(tester);

    expect(corpos['POST /portal/v1/devices'], {'token': 'token-1', 'platform': 'ANDROID'});
    // Quem já decidiu não vê o convite.
    expect(find.text('Receber avisos no celular'), findsNothing);

    fake.tokens.add('token-2');
    await tester.pumpAndSettle();
    expect(corpos['POST /portal/v1/devices'], {'token': 'token-2', 'platform': 'ANDROID'});
    expect(chamadas.where((c) => c == 'POST /portal/v1/devices').length, 2);
  });

  testWidgets('sair esquece o aparelho antes de encerrar a sessão', (tester) async {
    await abrirApp(tester);

    await tester.tap(find.byTooltip('Sair'));
    await tester.pumpAndSettle();

    expect(corpos['DELETE /portal/v1/devices'], {'token': 'token-1'});
    // Com o token da Clerk ainda no cabeçalho.
    expect(chamadas, contains('DELETE /portal/v1/devices'));
    expect(chamadas, isNot(contains('DELETE /portal/v1/devices (sem token)')));
  });

  testWidgets('sem decisão, o Início convida; o pedido do sistema só sai do toque',
      (tester) async {
    await abrirApp(tester, permissao: PermissaoDeAvisos.naoDecidida);

    expect(find.text('Receber avisos no celular'), findsOneWidget);
    expect(fake.pedidos, 0);
    expect(chamadas, isNot(contains('POST /portal/v1/devices')));

    await tester.tap(find.text('Ativar avisos'));
    await tester.pumpAndSettle();

    expect(fake.pedidos, 1);
    expect(find.text('Receber avisos no celular'), findsNothing);
    expect(corpos['POST /portal/v1/devices']!['token'], 'token-1');
  });

  testWidgets('"Agora não" some com o convite e fica guardado no aparelho', (tester) async {
    await abrirApp(tester, permissao: PermissaoDeAvisos.naoDecidida);

    await tester.tap(find.text('Agora não'));
    await tester.pumpAndSettle();

    expect(find.text('Receber avisos no celular'), findsNothing);
    expect(fake.pedidos, 0);
    expect(await cofre.avisosDispensados, isTrue);
  });

  testWidgets('recusado, o app não insiste e não registra nada', (tester) async {
    await abrirApp(tester, permissao: PermissaoDeAvisos.negada);

    expect(find.text('Receber avisos no celular'), findsNothing);
    expect(chamadas, isNot(contains('POST /portal/v1/devices')));
  });

  testWidgets('tocar no aviso de agendamento abre Meus agendamentos', (tester) async {
    await abrirApp(tester);

    fake.tocar(const AvisoTocado(slug: 'petshopteste', abre: 'agendamento'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(AppBar, 'Meus agendamentos'), findsOneWidget);
  });

  testWidgets('o aviso que abriu o app frio leva à conta depois de a sessão ficar pronta',
      (tester) async {
    await abrirApp(
      tester,
      inicial: const AvisoTocado(slug: 'petshopteste', abre: 'conta'),
    );

    expect(find.widgetWithText(AppBar, 'Minha conta'), findsOneWidget);
  });

  testWidgets('o aviso de outro petshop não navega', (tester) async {
    await abrirApp(tester);

    fake.tocar(const AvisoTocado(slug: 'outropetshop', abre: 'agendamento'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(AppBar, 'Meus agendamentos'), findsNothing);
    expect(find.text('Receber avisos no celular'), findsNothing);
  });

  testWidgets('com o app aberto, o aviso aparece na tela e leva ao destino', (tester) async {
    await abrirApp(tester);

    fake.emTela(const AvisoTocado(
      slug: 'petshopteste',
      abre: 'agendamento',
      titulo: 'A van está a caminho',
    ));
    await tester.pumpAndSettle();

    expect(find.text('A van está a caminho'), findsOneWidget);
    await tester.tap(find.text('Ver'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(AppBar, 'Meus agendamentos'), findsOneWidget);
  });
}

class _AvisosDeTeste implements Avisos {
  _AvisosDeTeste({required PermissaoDeAvisos permissao, AvisoTocado? inicial})
      : _permissao = permissao,
        _inicial = inicial;

  PermissaoDeAvisos _permissao;
  final AvisoTocado? _inicial;
  int pedidos = 0;

  final tokens = StreamController<String>.broadcast();
  final _tocados = StreamController<AvisoTocado>.broadcast();
  final _primeiroPlano = StreamController<AvisoTocado>.broadcast();

  void tocar(AvisoTocado aviso) => _tocados.add(aviso);
  void emTela(AvisoTocado aviso) => _primeiroPlano.add(aviso);

  void fechar() {
    tokens.close();
    _tocados.close();
    _primeiroPlano.close();
  }

  @override
  Future<bool> iniciar() async => true;

  @override
  Future<PermissaoDeAvisos> permissao() async => _permissao;

  @override
  Future<PermissaoDeAvisos> pedir() async {
    pedidos++;
    _permissao = PermissaoDeAvisos.concedida;
    return _permissao;
  }

  @override
  Future<String?> token() async => 'token-1';

  @override
  Stream<String> get tokensNovos => tokens.stream;

  @override
  Stream<AvisoTocado> get tocados => _tocados.stream;

  @override
  Future<AvisoTocado?> inicial() async => _inicial;

  @override
  Stream<AvisoTocado> get emPrimeiroPlano => _primeiroPlano.stream;

  @override
  String get plataforma => 'ANDROID';
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
  'tutor': {'id': 'tutor-1', 'name': 'Mário Moraes', 'petsCount': 1, 'balanceCents': 0},
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};
