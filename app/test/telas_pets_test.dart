import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// O caminho do tutor, percorrido de verdade e sem emulador.
///
/// Não é um golden de uma tela isolada: é a `Sessao` de produção, a navegação de
/// produção e o `CarregarDados` de produção contra respostas conhecidas. O emulador
/// Android desta máquina cai no meio de uma verificação — este arnês é o que garante
/// que "as telas abrem" não dependa de ele estar de pé no dia.
void main() {
  late List<String> chamadas;
  late Map<String, dynamic>? corpoDoPatch;
  late Map<String, dynamic> ficha;

  /// **A tela do teste é um celular.**
  ///
  /// O padrão do `flutter_test` é 800×600, que é a forma de um monitor deitado: nele o
  /// botão de salvar da folha inferior nasce fora da tela e o toque não acerta nada —
  /// sem erro, só sem efeito. A verificação precisa ter a forma do aparelho de quem usa.
  void telaDeCelular(WidgetTester tester) {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }

  Future<void> abrirApp(WidgetTester tester) async {
    telaDeCelular(tester);
    chamadas = [];
    corpoDoPatch = null;
    ficha = Map<String, dynamic>.from(_ficha);

    final portal = MockClient((req) async {
      chamadas.add('${req.method} ${req.url.path}');
      Map<String, dynamic>? corpo;
      switch ('${req.method} ${req.url.path}') {
        case 'GET /portal/v1/tenant':
          corpo = _tenant;
        case 'GET /portal/v1/me':
          corpo = _me;
        case 'GET /portal/v1/pets':
          corpo = {
            'pets': [_resumo(ficha), _resumo(_fichaEmMemoria)],
          };
        case 'GET /portal/v1/pets/pet-1':
          corpo = ficha;
        case 'GET /portal/v1/pets/pet-1/timeline':
          // O cursor vai na **query**, não no caminho: a página seguinte é a mesma
          // rota. Dublar por caminho devolveria a primeira página de novo, e a tela
          // apareceria correta acrescentando as mesmas linhas duas vezes.
          corpo = switch (req.url.queryParameters['cursor']) {
            null => _timeline,
            'cursor-2' => _timeline2,
            _ => null,
          };
          if (corpo == null) {
            return http.Response('{"detail":"não deu para carregar"}', 500,
                headers: {'content-type': 'application/json; charset=utf-8'});
          }
        case 'PATCH /portal/v1/pets/pet-1':
          corpoDoPatch = jsonDecode(req.body) as Map<String, dynamic>;
          // O servidor devolve a ficha **recarregada**, e é dela que a tela vive.
          ficha = {...ficha, ...corpoDoPatch!, 'name': corpoDoPatch!['name']};
          corpo = ficha;
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

  testWidgets('do Início à ficha, com o histórico embaixo', (tester) async {
    await abrirApp(tester);

    // Início: a saudação vem de `/me`, não de uma constante.
    expect(find.text('Olá, Mário Moraes'), findsOneWidget);

    await tester.tap(find.text('Meus Pets'));
    await tester.pumpAndSettle();

    expect(find.text('Marley'), findsOneWidget);
    // Na lista, os atributos são **pílulas**, uma por valor: a frase única quebrava no
    // meio dos separadores quando a raça era longa. A frase continua existindo na
    // ficha, onde há largura para ela — e é lá que este teste a confere, logo abaixo.
    expect(find.text('Cachorro'), findsOneWidget);
    expect(find.text('Poodle'), findsOneWidget);
    expect(find.text('11 anos'), findsOneWidget);
    // O falecido fica, na seção própria — e sem próximo agendamento.
    expect(find.text('Em memória'), findsOneWidget);
    expect(find.text('Fiona'), findsOneWidget);

    await tester.tap(find.text('Marley'));
    await tester.pumpAndSettle();

    // A ficha: o que se edita e o que não se edita, lado a lado.
    expect(find.text('A ficha'), findsOneWidget);
    expect(find.text('Cachorro · Poodle · 11 anos'), findsOneWidget);
    expect(find.text('09/03/2015'), findsOneWidget);
    expect(find.text('8,5 kg'), findsOneWidget);
    expect(find.text('Alergia a shampoo neutro'), findsOneWidget);

    // O histórico desceu junto, na mesma ida ao servidor — e continua sendo **uma**
    // chamada depois de rolar até ele: a rolagem constrói o que já estava no estado.
    expect(chamadas.where((c) => c.contains('timeline')).length, 1);
    await aVista(tester, find.text('Banho, Tosa'));
    expect(chamadas.where((c) => c.contains('timeline')).length, 1);
    expect(find.text('Banho, Tosa'), findsOneWidget);
    // O anulado aparece — o tutor levou o pet ali naquele dia.
    expect(find.text('Consulta veterinária'), findsOneWidget);
  });

  testWidgets('o campo limpo na folha de edição chega ao servidor como null',
      (tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Meus Pets'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Marley'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Editar'));
    await tester.pumpAndSettle();

    expect(find.text('Dados do Marley'), findsOneWidget);

    // Limpar a data é o caminho de volta ao "não sei".
    await tester.tap(find.byTooltip('Limpar'));
    await tester.pump();
    expect(find.text('Não informado'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'Marley II');
    await tester.ensureVisible(find.text('Salvar'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Salvar'));
    await tester.pumpAndSettle();

    expect(corpoDoPatch, isNotNull);
    expect(corpoDoPatch!.containsKey('birthDate'), isTrue);
    expect(corpoDoPatch!['birthDate'], isNull);
    expect(corpoDoPatch!['name'], 'Marley II');

    // A folha fechou e a ficha recarregou com o que o servidor devolveu.
    expect(find.text('Dados do Marley'), findsNothing);
    expect(find.text('Marley II'), findsWidgets);
    expect(find.text('Não informado'), findsWidgets);
  });

  testWidgets('a folha de edição mostra "Cancelar" sem precisar rolar',
      (tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Meus Pets'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Marley'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Editar'));
    await tester.pumpAndSettle();

    // A barra de ações é presa no rodapé da folha; de volta ao fim da coluna rolada,
    // os dois botões nascem abaixo da dobra e esta medida denuncia.
    final tela = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    final cancelar = tester.getRect(find.widgetWithText(TextButton, 'Cancelar'));
    expect(cancelar.bottom, lessThanOrEqualTo(tela));
    expect(
      tester.getRect(find.widgetWithText(InkWell, 'Salvar')).bottom,
      lessThanOrEqualTo(tela),
    );

    // E ele desiste de verdade, sem gravar nada.
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(find.text('Dados do Marley'), findsNothing);
    expect(corpoDoPatch, isNull);
  });

  testWidgets('a ficha do falecido não oferece o botão de editar', (tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Meus Pets'));
    await tester.pumpAndSettle();

    expect(find.text('Editar'), findsNothing);
  });

  testWidgets('"ver mais" acrescenta a página seguinte, e a falha tem saída',
      (tester) async {
    await abrirApp(tester);
    await tester.tap(find.text('Meus Pets'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Marley'));
    await tester.pumpAndSettle();

    Future<void> verMais() async {
      await aVista(tester, find.text('Ver mais'));
      await tester.tap(find.text('Ver mais'));
      await tester.pumpAndSettle();
    }

    await verMais();
    expect(find.text('Vacina V10'), findsOneWidget);
    // A página que chegou não repete a que já estava.
    expect(find.text('Banho, Tosa'), findsOneWidget);

    // A terceira responde 500: a tela diz o que houve e mantém o botão.
    await verMais();
    expect(find.text('não deu para carregar'), findsOneWidget);
    expect(find.text('Ver mais'), findsOneWidget);
  });
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
    'petsCount': 2,
    'balanceCents': 0,
  },
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};

const _ficha = {
  'id': 'pet-1',
  'name': 'Marley',
  'species': 'Cachorro',
  'breed': 'Poodle',
  'ageLabel': '11 anos',
  'photoUrl': null,
  'inMemoriam': false,
  'lastAttendanceAt': '2026-09-01T13:00:00.000Z',
  'nextAppointment': {
    'id': 'ag-1',
    'startsAt': '2026-09-28T13:00:00.000Z',
    'status': 'CONFIRMED',
    'services': ['Banho'],
  },
  'sex': 'MALE',
  'birthDate': '2015-03-09',
  'birthDatePrecision': 'EXACT',
  'neutered': true,
  'notes': null,
  'color': 'Branco',
  'weightKg': 8.5,
  'size': 'Pequeno',
  'coat': 'Encaracolado',
  'alerts': [
    {'kind': 'ALLERGY', 'label': 'shampoo neutro', 'severity': 'HIGH'},
  ],
};

const _fichaEmMemoria = {
  'id': 'pet-2',
  'name': 'Fiona',
  'species': 'Gato',
  'breed': null,
  'ageLabel': null,
  'photoUrl': null,
  'inMemoriam': true,
  'lastAttendanceAt': '2025-02-10T13:00:00.000Z',
  'nextAppointment': null,
};

/// A segunda página, com `nextCursor` que o dublê recusa — é assim que a tela mostra
/// as duas saídas: a que acrescenta e a que falha.
const _timeline2 = {
  'entries': [
    {
      'id': 'at-3',
      'type': 'VACCINE',
      'startedAt': '2026-01-20T13:00:00.000Z',
      'finishedAt': null,
      'professional': 'Dra. Ana',
      'services': ['Vacina V10'],
      'notes': [],
      'photoUrls': [],
      'weightKg': null,
      'voidedAt': null,
    },
  ],
  'nextCursor': 'cursor-3',
};

const _timeline = {
  'entries': [
    {
      'id': 'at-1',
      'type': 'BATH',
      'startedAt': '2026-09-01T13:00:00.000Z',
      'finishedAt': '2026-09-01T15:00:00.000Z',
      'professional': 'Marcelo',
      'services': ['Banho', 'Tosa'],
      'notes': ['Ficou tranquilo no secador.'],
      'photoUrls': [],
      'weightKg': 8.5,
      'voidedAt': null,
    },
    {
      'id': 'at-2',
      'type': 'VET_CONSULT',
      'startedAt': '2026-06-14T13:00:00.000Z',
      'finishedAt': null,
      'professional': null,
      'services': [],
      'notes': [],
      'photoUrls': [],
      'weightKg': null,
      'voidedAt': '2026-06-15T13:00:00.000Z',
    },
  ],
  'nextCursor': 'cursor-2',
};

Map<String, dynamic> _resumo(Map<String, dynamic> ficha) => {
      for (final chave in [
        'id',
        'name',
        'species',
        'breed',
        'ageLabel',
        'photoUrl',
        'inMemoriam',
        'lastAttendanceAt',
        'nextAppointment',
      ])
        chave: ficha[chave],
    };

/// Traz o alvo para a tela, rolando até ele se for preciso.
///
/// `ensureVisible` sozinho bastava enquanto a tela cabia no alcance do `cacheExtent`,
/// que constrói um pedaço além da dobra. Com os cartões do redesenho, o fim de uma tela
/// longa já nasce fora desse alcance — e `ensureVisible` sobre um widget que ainda não
/// existe estoura com "Bad state: No element", que não diz nada sobre a causa. A rolagem
/// primeiro **constrói**; o `ensureVisible` depois garante que o alvo está de fato sob o
/// dedo, porque toque fora da tela não erra: ele não acontece.
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
