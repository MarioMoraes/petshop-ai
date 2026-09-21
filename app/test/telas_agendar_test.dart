import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// Marcar horário, percorrido de ponta a ponta sem emulador (MOD-PORTAL-05).
///
/// A tela erra o tempo todo por motivos legítimos — o horário que acabou de ser tomado,
/// o alerta clínico a reconhecer, a conta em aberto —, e cada um tem uma saída própria.
/// São esses desfechos que este arquivo exercita: o caminho feliz é o mais curto deles.
/// O `pt_BR` separa o símbolo do número com espaço inquebrável — ver `dinheiro.dart`.
const noventaReais = 'R\$\u00A090,00';

void main() {
  late List<String> chamadas;
  late List<Map<String, dynamic>> pedidos;

  /// A grade que a próxima consulta de disponibilidade vai devolver, e a resposta que o
  /// próximo POST vai dar. Trocá-las entre um toque e outro é como se monta uma recusa.
  late List<Map<String, dynamic>> grade;
  late http.Response Function()? recusaDoPost;

  /// Quando preenchido, a consulta de disponibilidade **espera** — é o que permite
  /// deixar duas buscas no ar ao mesmo tempo.
  late List<Completer<http.Response>> esperas;
  late bool segurarDisponibilidade;

  Future<void> abrirApp(
    WidgetTester tester, {
    bool agendamentoLigado = true,
    bool exigeAprovacao = false,
    int pets = 1,
  }) async {
    chamadas = [];
    pedidos = [];
    grade = [_slot('13:00', _prof1), _slot('14:00', _prof1)];
    recusaDoPost = null;
    esperas = [];
    segurarDisponibilidade = false;

    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final portal = MockClient((req) async {
      chamadas.add('${req.method} ${req.url.path}');
      Map<String, dynamic>? corpo;

      switch ('${req.method} ${req.url.path}') {
        case 'GET /portal/v1/tenant':
          corpo = _tenant;
        case 'GET /portal/v1/me':
          corpo = _me(
            agendamentoLigado: agendamentoLigado,
            exigeAprovacao: exigeAprovacao,
          );
        case 'GET /portal/v1/pets':
          corpo = {
            'pets': [
              _resumo('pet-1', 'Marley'),
              if (pets > 1) _resumo('pet-2', 'Fiona'),
              // O falecido não pode virar opção de agendamento.
              {..._resumo('pet-3', 'Bolinha'), 'inMemoriam': true},
            ],
          };
        case 'GET /portal/v1/booking/services':
          corpo = _servicos;
        case 'GET /portal/v1/booking/availability':
          final resposta = http.Response(
            jsonEncode({..._disponibilidade, 'slots': grade}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
          if (!segurarDisponibilidade) return resposta;
          final espera = Completer<http.Response>();
          esperas.add(espera);
          return espera.future;
        case 'POST /portal/v1/booking':
          pedidos.add(jsonDecode(req.body) as Map<String, dynamic>);
          final recusa = recusaDoPost;
          if (recusa != null) return recusa();
          corpo = _agendamento(exigeAprovacao: exigeAprovacao);
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
  }

  Future<void> irParaAgendar(WidgetTester tester) async {
    await tester.tap(find.text('Marcar horário'));
    await tester.pumpAndSettle();
  }

  /// O botão de confirmar nasce no fim de uma coluna que cresce a cada resposta, e num
  /// celular ele está sempre abaixo da dobra — quase sempre fora até do alcance do
  /// `cacheExtent`. Rolar até ele primeiro, porque um toque fora da tela não erra: ele
  /// simplesmente não acontece.
  Future<void> confirmar(WidgetTester tester, [String rotulo = 'Confirmar horário']) async {
    await aVista(tester, find.text(rotulo));
    await tester.tap(find.text(rotulo));
    await tester.pumpAndSettle();
  }

  /// O seletor de data é um diálogo do Material: aceitar o dia que ele já propõe é
  /// tocar em OK, e é o bastante — quem responde a grade é o servidor.
  Future<void> escolherHoje(WidgetTester tester) async {
    await tester.tap(find.text('Escolher o dia'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
  }

  testWidgets('do Início ao comprovante, com o instante em UTC', (tester) async {
    await abrirApp(tester);
    await irParaAgendar(tester);

    // Um pet só: a pergunta "para quem é" não existe, e o passo 1 é o serviço.
    expect(find.text('Para quem é'), findsNothing);
    expect(find.textContaining('PASSO 1'), findsOneWidget);
    expect(find.text('Banho'), findsOneWidget);
    expect(find.text(noventaReais), findsOneWidget);
    // O serviço sem preço para o porte não desce do servidor; nada a esconder aqui.

    await tester.tap(find.text('Banho'));
    await tester.pumpAndSettle();
    await escolherHoje(tester);

    // A grade desce em UTC e aparece na hora do petshop: 13:00Z é 10:00 em São Paulo.
    expect(find.text('10:00'), findsOneWidget);
    expect(find.text('11:00'), findsOneWidget);

    await tester.tap(find.text('10:00'));
    await tester.pumpAndSettle();

    expect(find.text('Tudo certo?'), findsOneWidget);
    expect(find.text('Marley · Banho'), findsOneWidget);

    await confirmar(tester);

    expect(pedidos, hasLength(1));
    final pedido = pedidos.single;
    // **O instante volta como veio.** Um `toLocal()` no meio do caminho mandaria a hora
    // do aparelho com cara de UTC, e o pet chegaria três horas atrasado.
    expect(pedido['startsAt'], '2026-09-23T13:00:00.000Z');
    expect(pedido['professionalId'], _prof1);
    expect(pedido['serviceIds'], ['servico-banho']);
    expect(pedido['acknowledgedAlerts'], isFalse);
    // `semNulos`: o pedido sem observação e sem leva-e-traz não diz `null`, não diz nada
    // — os dois campos são `.optional()` e o schema é `.strict()`.
    expect(pedido.containsKey('notes'), isFalse);
    expect(pedido.containsKey('taxi'), isFalse);

    expect(find.text('Horário marcado'), findsOneWidget);
    expect(find.text(noventaReais), findsWidgets);
  });

  testWidgets('o alerta clínico é um "tem certeza?", e a segunda tentativa passa',
      (tester) async {
    await abrirApp(tester);
    await irParaAgendar(tester);
    await tester.tap(find.text('Banho'));
    await tester.pumpAndSettle();
    await escolherHoje(tester);
    await tester.tap(find.text('10:00'));
    await tester.pumpAndSettle();

    recusaDoPost = () => http.Response(
          jsonEncode({
            'code': 'ERR_AGENDA_009',
            'detail': 'O Marley tem alerta de alergia. Confirme que você está ciente.',
          }),
          422,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );

    await confirmar(tester);

    expect(find.text('Atenção no atendimento'), findsOneWidget);
    expect(pedidos.single['acknowledgedAlerts'], isFalse);

    // O botão muda de texto: pedir a mesma resposta duas vezes sem avisar que algo
    // mudou é o que faz alguém tocar de novo achando que a primeira falhou.
    expect(find.text('Confirmar mesmo assim'), findsOneWidget);

    recusaDoPost = null;
    await confirmar(tester, 'Confirmar mesmo assim');

    expect(pedidos, hasLength(2));
    expect(pedidos.last['acknowledgedAlerts'], isTrue);
    expect(find.text('Horário marcado'), findsOneWidget);
  });

  testWidgets('a recusa por conflito oferece os horários que o servidor sondou',
      (tester) async {
    await abrirApp(tester);
    await irParaAgendar(tester);
    await tester.tap(find.text('Banho'));
    await tester.pumpAndSettle();
    await escolherHoje(tester);
    await tester.tap(find.text('10:00'));
    await tester.pumpAndSettle();

    recusaDoPost = () => http.Response(
          jsonEncode({
            'code': 'ERR_AGENDA_004',
            'detail': 'Este horário acabou de ser preenchido.',
            'alternativeStartsAt': ['2026-09-23T14:00:00.000Z'],
          }),
          409,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );

    await confirmar(tester);

    expect(find.text('Não deu para marcar'), findsOneWidget);
    expect(find.text('Este horário acabou de ser preenchido.'), findsOneWidget);

    // A alternativa é um botão, e tocar nele troca a escolha sem rolar para cima.
    recusaDoPost = null;
    await tester.ensureVisible(find.text('11:00').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('11:00').last);
    await tester.pumpAndSettle();
    await confirmar(tester);

    expect(pedidos.last['startsAt'], '2026-09-23T14:00:00.000Z');
  });

  testWidgets('duas buscas no ar: vence a última pedida, não a última a chegar',
      (tester) async {
    await abrirApp(tester);
    await irParaAgendar(tester);
    await tester.tap(find.text('Banho'));
    await tester.pumpAndSettle();
    await escolherHoje(tester);

    segurarDisponibilidade = true;

    // Primeira busca: troca do conjunto de serviços (a duração muda, a grade muda).
    grade = [_slot('13:00', _prof1)];
    await tester.tap(find.text('Tosa'));
    await tester.pump();

    // Segunda busca, antes de a primeira responder.
    grade = [_slot('18:00', _prof1)];
    await tester.tap(find.text('Tosa'));
    await tester.pump();

    expect(esperas, hasLength(2));

    // A **segunda** responde primeiro, e a primeira chega depois — o caso que faz o
    // horário fantasma aparecer.
    esperas[1].complete(http.Response(
      jsonEncode({..._disponibilidade, 'slots': [_slot('18:00', _prof1)]}),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    ));
    await tester.pumpAndSettle();
    esperas[0].complete(http.Response(
      jsonEncode({..._disponibilidade, 'slots': [_slot('13:00', _prof1)]}),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    ));
    await tester.pumpAndSettle();

    // 18:00Z é 15:00 em São Paulo; 13:00Z seria 10:00.
    expect(find.text('15:00'), findsOneWidget);
    expect(find.text('10:00'), findsNothing);
  });

  testWidgets('sem agendamento online, a porta não aparece no Início', (tester) async {
    await abrirApp(tester, agendamentoLigado: false);
    expect(find.text('Meus pets'), findsOneWidget);
    expect(find.text('Marcar horário'), findsNothing);
  });

  testWidgets('com aprovação, o aviso vem antes e o comprovante diz reservado',
      (tester) async {
    await abrirApp(tester, exigeAprovacao: true);
    await irParaAgendar(tester);

    expect(
      find.text('O horário fica reservado e o estabelecimento confirma em seguida.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Banho'));
    await tester.pumpAndSettle();
    await escolherHoje(tester);
    await tester.tap(find.text('10:00'));
    await tester.pumpAndSettle();
    await confirmar(tester);

    expect(find.text('Horário reservado'), findsOneWidget);
  });

  testWidgets('com mais de um pet, a pergunta existe e o falecido fica de fora',
      (tester) async {
    await abrirApp(tester, pets: 2);
    await irParaAgendar(tester);

    expect(find.text('Para quem é'), findsOneWidget);
    expect(find.text('Marley'), findsOneWidget);
    expect(find.text('Fiona'), findsOneWidget);
    expect(find.text('Bolinha'), findsNothing);

    // Sem pet escolhido não há serviços: a pergunta seguinte só abre depois da resposta.
    expect(find.text('Banho'), findsNothing);

    await tester.tap(find.text('Fiona'));
    await tester.pumpAndSettle();
    expect(find.text('Banho'), findsOneWidget);
  });
}

const _prof1 = '3f1e0d2c-1111-4a2b-8c3d-000000000001';

Map<String, dynamic> _slot(String hora, String profissional) => {
      'startsAt': '2026-09-23T$hora:00.000Z',
      'endsAt': '2026-09-23T$hora:00.000Z',
      'professionalId': profissional,
      'professionalName': 'Marcelo',
    };

const _tenant = {
  'name': 'PetShop Teste',
  'slug': 'petshopteste',
  'logoUrl': null,
  'brandColor': '#E34A32',
  'portalEnabled': true,
};

Map<String, dynamic> _me({
  required bool agendamentoLigado,
  required bool exigeAprovacao,
}) =>
    {
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
        'onlineBookingEnabled': agendamentoLigado,
        'onlineBookingRequiresApproval': exigeAprovacao,
        // O leva-e-traz fica fora desta etapa: ligado ou desligado, a tela é a mesma.
        'taxiEnabled': true,
      },
    };

Map<String, dynamic> _resumo(String id, String nome) => {
      'id': id,
      'name': nome,
      'species': 'Cachorro',
      'breed': 'Poodle',
      'ageLabel': '11 anos',
      'photoUrl': null,
      'inMemoriam': false,
      'lastAttendanceAt': null,
      'nextAppointment': null,
    };

const _servicos = {
  'petName': 'Marley',
  'services': [
    {
      'id': 'servico-banho',
      'name': 'Banho',
      'description': 'Com secagem e perfume',
      'category': 'BATH',
      'priceCents': 9000,
      'durationMin': 60,
    },
    {
      'id': 'servico-tosa',
      'name': 'Tosa',
      'description': null,
      'category': 'GROOMING',
      'priceCents': 7000,
      'durationMin': 45,
    },
  ],
};

const _disponibilidade = {
  'slots': [],
  'nextAvailable': null,
  'durationMin': 60,
  'priceCents': 9000,
  'timezone': 'America/Sao_Paulo',
  'minNoticeHours': 2,
};

/// **A forma que o `POST /booking` devolve de verdade** — e não a do detalhe do
/// agendamento, que foi a suposição da fatia 1. Sem `actions`, sem `petId`, sem
/// `serviceIds`, sem `source`; com `duplicate` e `taxiWarning`. Quem provou foi
/// `tool/smoke_booking.dart`, contra o servidor.
Map<String, dynamic> _agendamento({required bool exigeAprovacao}) => {
      'id': '9f1e0d2c-2222-4a2b-8c3d-000000000002',
      'status': exigeAprovacao ? 'PENDING' : 'CONFIRMED',
      'startsAt': '2026-09-23T13:00:00.000Z',
      'endsAt': '2026-09-23T14:00:00.000Z',
      'petName': 'Marley',
      'professionalName': 'Marcelo',
      'services': ['Banho'],
      'totalCents': 9000,
      'awaitingApproval': exigeAprovacao,
      'duplicate': false,
      'taxi': [],
      'taxiWarning': null,
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
