import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// Meus agendamentos, percorrido de ponta a ponta sem emulador (MOD-PORTAL-06).
void main() {
  late List<String> chamadas;
  late List<Map<String, dynamic>> corposDeCancelamento;
  late List<Map<String, dynamic>> corposDeRemarcacao;

  /// Trocar isto entre um toque e outro é como se monta a recusa do servidor.
  late http.Response Function()? recusaDoCancelamento;

  /// Os `actions` do agendamento futuro — é o servidor que decide quais botões existem.
  late Map<String, dynamic> acoes;

  Future<void> abrirApp(
    WidgetTester tester, {
    bool comTaxi = false,
    bool semNada = false,
  }) async {
    chamadas = [];
    corposDeCancelamento = [];
    corposDeRemarcacao = [];
    recusaDoCancelamento = null;
    acoes = {
      'canCancel': true,
      'canReschedule': true,
      'cancelIsLate': false,
      'cancelFeeCents': 0,
      'cancellationWindowHours': 24,
    };

    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final portal = MockClient((req) async {
      final rota = '${req.method} ${req.url.path}';
      chamadas.add(rota);
      Map<String, dynamic>? corpo;

      switch (rota) {
        case 'GET /portal/v1/tenant':
          corpo = _tenant;
        case 'GET /portal/v1/me':
          corpo = _me;
        case 'GET /portal/v1/appointments':
          final cursor = req.url.queryParameters['cursor'];
          corpo = semNada
              ? {'upcoming': [], 'past': [], 'nextCursor': null, 'timezone': _fuso}
              : {
                  // A rota **ignora o cursor** para o bloco dos próximos e o devolve
                  // inteiro em toda página: é o dublê reproduzindo a armadilha.
                  'upcoming': [_proximo(acoes, comTaxi: comTaxi)],
                  'past': cursor == null ? [_passado1, _passado2] : [_passado3],
                  'nextCursor': cursor == null ? '2026-08-01T13:00:00.000Z' : null,
                  'timezone': _fuso,
                };
        case 'GET /portal/v1/appointments/ag-1':
          corpo = _detalhe(comTaxi: comTaxi);
        case 'POST /portal/v1/appointments/ag-1/cancel':
          corposDeCancelamento.add(jsonDecode(req.body) as Map<String, dynamic>);
          final recusa = recusaDoCancelamento;
          if (recusa != null) return recusa();
          corpo = {..._detalhe(comTaxi: comTaxi), 'status': 'CANCELLED'};
        case 'POST /portal/v1/appointments/ag-1/reschedule':
          corposDeRemarcacao.add(jsonDecode(req.body) as Map<String, dynamic>);
          corpo = _detalhe(comTaxi: false);
        case 'GET /portal/v1/booking/availability':
          corpo = _disponibilidade;
        default:
          return http.Response('{"detail":"rota nao dublada"}', 404,
              headers: {'content-type': 'application/json; charset=utf-8'});
      }

      return http.Response(jsonEncode(corpo), 200,
          headers: {'content-type': 'application/json; charset=utf-8'});
    });

    final cofre = CofreEmMemoria();
    await cofre.gravarSlug('petshopteste');
    await cofre.gravarSessaoId('sess_1');

    await tester.pumpWidget(App(
      sessao: Sessao(
        armazenamento: cofre,
        clerk: ClerkFapi(
          host: 'exemplo.clerk.accounts.dev',
          armazenamento: CofreEmMemoria(),
          http_: MockClient((_) async => http.Response(
                jsonEncode({'jwt': 'token-de-teste'}),
                200,
                headers: {'content-type': 'application/json; charset=utf-8'},
              )),
        ),
        http_: portal,
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Meus agendamentos'));
    await tester.pumpAndSettle();
  }

  Future<void> tocar(WidgetTester tester, String rotulo) async {
    await tester.ensureVisible(find.text(rotulo).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text(rotulo).last);
    await tester.pumpAndSettle();
  }

  testWidgets('os próximos e o histórico na mesma tela, com a hora do petshop',
      (tester) async {
    await abrirApp(tester);

    // 13:00Z é 10:00 em São Paulo.
    expect(find.textContaining('às 10:00'), findsOneWidget);
    expect(find.text('Marley · Banho'), findsOneWidget);
    expect(find.text('com Marcelo'), findsOneWidget);
    expect(find.text('Histórico'), findsOneWidget);
    // O cancelado **aparece** no histórico, em vez de sumir.
    expect(find.text('Cancelado'), findsOneWidget);
    expect(find.text('Não compareceu'), findsOneWidget);
  });

  testWidgets('"ver mais" acrescenta só o passado, e não repete os próximos',
      (tester) async {
    await abrirApp(tester);

    expect(find.textContaining('às 10:00'), findsOneWidget);

    await tocar(tester, 'Ver mais');

    expect(find.text('Bolinha · Consulta'), findsOneWidget);
    // A armadilha: a segunda página trouxe o mesmo bloco de próximos, e o cartão não
    // pode aparecer duas vezes.
    expect(find.textContaining('às 10:00'), findsOneWidget);
    expect(find.text('Ver mais'), findsNothing);
  });

  testWidgets('os botões vêm do servidor: sem ação, sem botão', (tester) async {
    await abrirApp(tester);
    expect(find.text('Cancelar'), findsOneWidget);
    expect(find.text('Remarcar'), findsOneWidget);

    // O mesmo agendamento, com a agenda já em andamento: o servidor fecha as duas
    // portas e a tela obedece em vez de recalcular a máquina de estado.
    acoes = {
      'canCancel': false,
      'canReschedule': false,
      'cancelIsLate': false,
      'cancelFeeCents': 0,
      'cancellationWindowHours': 24,
    };
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();

    expect(find.text('Cancelar'), findsNothing);
    expect(find.text('Remarcar'), findsNothing);
  });

  testWidgets('cancelar dentro da janela não fala em taxa', (tester) async {
    await abrirApp(tester);
    await tocar(tester, 'Cancelar');

    expect(
      find.text('O horário volta para a agenda do estabelecimento e não há nenhuma taxa.'),
      findsOneWidget,
    );

    await tocar(tester, 'Cancelar mesmo assim');

    expect(corposDeCancelamento.single['acknowledgeFee'], isFalse);
    // A folha fechou e a lista foi pedida de novo.
    expect(find.text('Cancelar mesmo assim'), findsNothing);
    expect(chamadas.where((c) => c == 'GET /portal/v1/appointments').length, 2);
  });

  testWidgets('cancelar fora da janela mostra a taxa antes e a reconhece no corpo',
      (tester) async {
    await abrirApp(tester);
    acoes = {
      'canCancel': true,
      'canReschedule': true,
      'cancelIsLate': true,
      'cancelFeeCents': 4500,
      'cancellationWindowHours': 24,
    };
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await tester.pumpAndSettle();

    await tocar(tester, 'Cancelar');
    expect(find.textContaining('taxa de R\$ 45,00'), findsOneWidget);
    expect(find.textContaining('menos de 24h'), findsOneWidget);

    await tocar(tester, 'Cancelar mesmo assim');
    expect(corposDeCancelamento.single['acknowledgeFee'], isTrue);
  });

  testWidgets('a tela velha aprende com o servidor: ERR_PORTAL_011 pede o segundo toque',
      (tester) async {
    await abrirApp(tester);

    // A tela abriu achando que não havia taxa — e a janela fechou enquanto isso.
    recusaDoCancelamento = () => http.Response(
          jsonEncode({
            'code': 'ERR_PORTAL_011',
            'detail': 'Faltam menos de 24h para o horário.',
            'feeCents': 4500,
            'cancellationWindowHours': 24,
            'requiresFeeAcknowledgement': true,
          }),
          422,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );

    await tocar(tester, 'Cancelar');
    await tocar(tester, 'Cancelar mesmo assim');

    // Não cancelou às escondidas: a folha continua aberta, agora com o número do
    // servidor.
    expect(corposDeCancelamento.single['acknowledgeFee'], isFalse);
    expect(find.textContaining('taxa de R\$ 45,00'), findsOneWidget);

    recusaDoCancelamento = null;
    await tocar(tester, 'Cancelar mesmo assim');

    expect(corposDeCancelamento, hasLength(2));
    expect(corposDeCancelamento.last['acknowledgeFee'], isTrue);
  });

  testWidgets('remarcar busca a grade com os serviços do detalhe', (tester) async {
    await abrirApp(tester);
    await tocar(tester, 'Remarcar');

    expect(find.text('Hoje está marcado'), findsOneWidget);
    expect(find.text('Novo horário'), findsOneWidget);

    await tocar(tester, 'Escolher o dia');
    await tocar(tester, 'OK');

    // Os `serviceIds` vêm do **detalhe**: o resumo da lista não os traz.
    expect(chamadas, contains('GET /portal/v1/appointments/ag-1'));
    expect(find.text('15:00'), findsOneWidget);

    await tocar(tester, '15:00');
    expect(find.textContaining('O horário passa para'), findsOneWidget);

    await tocar(tester, 'Confirmar novo horário');

    expect(corposDeRemarcacao.single['startsAt'], '2026-09-30T18:00:00.000Z');
    expect(corposDeRemarcacao.single['professionalId'], _prof);
  });

  testWidgets('com leva-e-traz, as duas telas avisam o que acontece com ele',
      (tester) async {
    await abrirApp(tester, comTaxi: true);

    expect(find.textContaining('Ida · A caminho'), findsOneWidget);

    await tocar(tester, 'Cancelar');
    expect(
      find.text('O leva-e-traz deste horário é cancelado junto, sem cobrança.'),
      findsOneWidget,
    );
    await tocar(tester, 'Manter horário');

    await tocar(tester, 'Remarcar');
    expect(find.text('O leva-e-traz não vai junto'), findsOneWidget);
  });

  testWidgets('sem nada marcado, a tela diz o que fazer', (tester) async {
    await abrirApp(tester, semNada: true);
    expect(find.text('Nenhum horário por aqui'), findsOneWidget);
    expect(
      find.text('Quando você marcar um horário, ele aparece nesta tela.'),
      findsOneWidget,
    );
  });
}

const _fuso = 'America/Sao_Paulo';
const _prof = '3f1e0d2c-1111-4a2b-8c3d-000000000001';

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
    'timezone': _fuso,
  },
  'tutor': {'id': 'tutor-1', 'name': 'Mário Moraes', 'petsCount': 1, 'balanceCents': 0},
  'features': {
    'portalEnabled': true,
    'onlineBookingEnabled': true,
    'onlineBookingRequiresApproval': false,
    'taxiEnabled': true,
  },
};

const _corridas = [
  {
    'id': 'corrida-1',
    'leg': 'PICKUP',
    'legLabel': 'Ida',
    'status': 'EN_ROUTE',
    'statusText': 'A caminho',
    'windowStartsAt': '2026-09-28T12:00:00.000Z',
    'windowEndsAt': '2026-09-28T12:30:00.000Z',
    'priceCents': 1500,
  },
];

Map<String, dynamic> _proximo(Map<String, dynamic> acoes, {required bool comTaxi}) => {
      'id': 'ag-1',
      'status': 'CONFIRMED',
      'startsAt': '2026-09-28T13:00:00.000Z',
      'endsAt': '2026-09-28T14:00:00.000Z',
      'petId': 'pet-1',
      'petName': 'Marley',
      'professionalName': 'Marcelo',
      'services': ['Banho'],
      'totalCents': 9000,
      'awaitingApproval': false,
      'taxi': comTaxi ? _corridas : const [],
      'actions': acoes,
    };

Map<String, dynamic> _detalhe({required bool comTaxi}) => {
      ..._proximo(const {
        'canCancel': true,
        'canReschedule': true,
        'cancelIsLate': false,
        'cancelFeeCents': 0,
        'cancellationWindowHours': 24,
      }, comTaxi: comTaxi),
      'source': 'PORTAL',
      'serviceIds': ['servico-banho'],
      'cancelledAt': null,
      'cancelledLate': null,
    };

const _passado1 = {
  'id': 'ag-2',
  'status': 'CANCELLED',
  'startsAt': '2026-09-10T13:00:00.000Z',
  'endsAt': '2026-09-10T14:00:00.000Z',
  'petId': 'pet-1',
  'petName': 'Marley',
  'professionalName': 'Marcelo',
  'services': ['Tosa'],
  'totalCents': 7000,
  'awaitingApproval': false,
  'taxi': [],
};

const _passado2 = {
  'id': 'ag-3',
  'status': 'NO_SHOW',
  'startsAt': '2026-09-01T13:00:00.000Z',
  'endsAt': '2026-09-01T14:00:00.000Z',
  'petId': 'pet-2',
  // Outro pet de propósito: com o mesmo nome e o mesmo serviço do cartão de cima, a
  // asserção do bloco "próximos" casaria com uma linha do histórico sem querer.
  'petName': 'Fiona',
  'professionalName': 'Ana',
  'services': ['Banho'],
  'totalCents': 9000,
  'awaitingApproval': false,
  'taxi': [],
};

const _passado3 = {
  'id': 'ag-4',
  'status': 'COMPLETED',
  'startsAt': '2026-07-15T13:00:00.000Z',
  'endsAt': '2026-07-15T14:00:00.000Z',
  'petId': 'pet-2',
  'petName': 'Bolinha',
  'professionalName': 'Ana',
  'services': ['Consulta'],
  'totalCents': 32000,
  'awaitingApproval': false,
  'taxi': [],
};

const _disponibilidade = {
  'slots': [
    {
      'startsAt': '2026-09-30T18:00:00.000Z',
      'endsAt': '2026-09-30T19:00:00.000Z',
      'professionalId': _prof,
      'professionalName': 'Marcelo',
    },
  ],
  'nextAvailable': null,
  'durationMin': 60,
  'priceCents': 9000,
  'timezone': _fuso,
  'minNoticeHours': 2,
};
