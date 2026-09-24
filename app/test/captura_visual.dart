import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/app.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/auth/sessao.dart';

/// O arnês de captura: as telas renderizadas com as fontes de verdade, em PNG.
///
/// Não é teste — não afirma nada. Existe para que o redesenho possa ser **olhado** numa
/// máquina onde o emulador Android não sobe. Roda com
/// `flutter test test/captura_visual.dart --update-goldens` e escreve em
/// `test/capturas/`.
void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // Sem isto o texto sai no tipo de reserva do `flutter_test`, onde toda letra é um
    // quadrado do tamanho do corpo — e a captura diria mais sobre a fonte de teste do
    // que sobre o desenho.
    await _carregar('Inter', [
      'Inter-Regular.ttf',
      'Inter-Medium.ttf',
      'Inter-SemiBold.ttf',
      'Inter-Bold.ttf',
    ]);
    // O `flutter test` não embarca a fonte de ícones: sem ela todo ícone vira um
    // quadrado vazio na captura, e metade do que se quer olhar é justamente ícone.
    final raiz = File(Platform.resolvedExecutable).parent.parent.parent.parent.path;
    await _carregarDe('MaterialIcons',
        ['$raiz/artifacts/material_fonts/MaterialIcons-Regular.otf']);
  });

  testWidgets('captura', (tester) async {
    tester.view.physicalSize = const Size(1170, 2100);
    tester.view.devicePixelRatio = 3;
    // **O celular tem recortes, e o emulador da captura não tinha.** Sem isto, a barra
    // de status e a de navegação valem zero aqui — e foi assim que o rodapé cortado da
    // lista chegou ao aparelho do usuário sem aparecer em nenhuma captura.
    tester.view.padding = const FakeViewPadding(top: 141, bottom: 144);
    tester.view.viewPadding = const FakeViewPadding(top: 141, bottom: 144);
    addTearDown(tester.view.reset);

    Future<void> clique(String texto) async {
      // O Início rola desde que ganhou "Meus documentos": a última linha nasce abaixo da
      // dobra num celular com recortes.
      await tester.ensureVisible(find.text(texto));
      await tester.pumpAndSettle();
      await tester.tap(find.text(texto));
      await tester.pumpAndSettle();
    }

    /// Volta até o Início pelo `Navigator`, e não pelo botão da barra.
    ///
    /// O botão existe, mas depende de estar visível e de qual rota está por cima; aqui
    /// o que se quer é só chegar ao começo para continuar fotografando.
    Future<void> aoInicio() async {
      final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
      while (nav.canPop()) {
        nav.pop();
        await tester.pumpAndSettle();
      }
    }

    Future<void> foto(String nome) async {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('capturas/$nome.png'),
      );
    }

    // ── a abertura ────────────────────────────────────────────────────────────
    //
    // Ela só existe em movimento, então são três quadros pelo relógio da animação, e
    // não um `pumpAndSettle` — que a atravessaria inteira e fotografaria a tela de
    // depois. Os instantes são os três momentos que ela tem: a marca pousando, o coxim
    // sendo traçado com o reflexo passando por cima, e o nome já assentado.
    await tester.pumpWidget(App(sessao: _sessao(cofre: CofreEmMemoria())));
    await tester.pump(const Duration(milliseconds: 380));
    await foto('00a-abertura-marca');
    await tester.pump(const Duration(milliseconds: 420));
    await foto('00b-abertura-traco');
    await tester.pump(const Duration(milliseconds: 320));
    await foto('00c-abertura-nome');

    // ── a primeira tela, sem petshop escolhido ────────────────────────────────
    await tester.pumpAndSettle();
    await foto('01-escolher-petshop');

    await clique('PetShop Amarillys');
    await foto('02-entrar');

    // ── o app com sessão ──────────────────────────────────────────────────────
    final cofre = CofreEmMemoria();
    await cofre.gravarSlug('petshopamarillys');
    await cofre.gravarSessaoId('sess_1');

    // Árvore nova, e não `pumpWidget` por cima: o `App` de cima tem o mesmo tipo e
    // nenhuma chave, então o Flutter reaproveita o elemento — e com ele a `Sessao`
    // antiga, que não sabe do vínculo.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(App(key: const ValueKey('app2'), sessao: _sessao(cofre: cofre)));
    await tester.pumpAndSettle();
    await foto('03-inicio');

    await clique('Meus pets');
    await foto('04-meus-pets');

    await clique('Marley');
    await foto('05-ficha-do-pet');

    await tester.drag(find.byType(ListView).last, const Offset(0, -420));
    await tester.pumpAndSettle();
    await foto('06-historico');

    await tester.drag(find.byType(ListView).last, const Offset(0, 420));
    await tester.pumpAndSettle();
    await clique('Editar');
    await foto('07-editar-pet');

    // Pelo "Cancelar", e sem rolar: a barra de ações da folha é presa no rodapé, e o
    // toque num widget fora da tela não acontece — se ela voltar para o fim da coluna
    // rolada, esta linha falha em vez de a captura sair igual.
    await clique('Cancelar');
    await aoInicio();

    // ── agendamentos ──────────────────────────────────────────────────────────
    await clique('Meus agendamentos');
    await foto('08-agendamentos');

    // O fim da lista, que é onde o rodapé encostava na barra do sistema.
    await tester.drag(find.byType(ListView).last, const Offset(0, -900));
    await tester.pumpAndSettle();
    await foto('08b-agendamentos-fim');

    await clique('Cancelar');
    await foto('09-cancelar');

    await clique('Manter horário');
    await aoInicio();

    // ── marcar horário ────────────────────────────────────────────────────────
    await clique('Marcar horário');
    await foto('10-marcar-servicos');

    await clique('Banho');
    await foto('10b-leva-e-traz');

    // As duas pernas: é com elas marcadas que o cartão mostra o endereço e a janela, e
    // é o único estado em que a confirmação tem a linha do transporte.
    await clique('Buscar em casa');
    await clique('Devolver em casa');

    // O seletor de dia desceu abaixo da dobra quando o leva-e-traz entrou entre ele e
    // os serviços — toque em widget fora da tela não acontece.
    await tester.drag(find.byType(ListView).last, const Offset(0, -320));
    await tester.pumpAndSettle();
    await clique('Escolher o dia');
    await clique('OK');
    await foto('11-grade');

    await clique('10:00');
    // O "Tudo certo?" fecha uma coluna que cresceu de três cartões para quatro: sem
    // descer o bastante, o toque em "Confirmar horário" cai fora da tela e não
    // acontece — e as duas fotos saem iguais, que é como isso se manifesta aqui.
    await tester.drag(find.byType(ListView).last, const Offset(0, -700));
    await tester.pumpAndSettle();
    await foto('12-confirmar');

    await clique('Confirmar horário');
    await foto('13-comprovante');

    // O comprovante cresceu com as duas corridas, e o total — que é o único número que
    // soma o transporte ao atendimento — passou a nascer abaixo da dobra.
    await tester.drag(find.byType(ListView).last, const Offset(0, -420));
    await tester.pumpAndSettle();
    await foto('13b-comprovante-total');
    await aoInicio();

    // ── minha conta ───────────────────────────────────────────────────────────
    //
    // A tela é longa e desce em três assuntos — o saldo, os pacotes e os lançamentos —,
    // com o "Como pagar" no pé. Duas fotos, porque a dobra do celular corta no meio do
    // extrato e é justamente o pé que ninguém olha.
    await clique('Minha conta');
    await foto('16-minha-conta');

    await tester.drag(find.byType(ListView).last, const Offset(0, -700));
    await tester.pumpAndSettle();
    await foto('16b-minha-conta-como-pagar');
    await aoInicio();

    // ── meus dados ────────────────────────────────────────────────────────────
    //
    // A tela e três das quatro folhas: a do contato nos dois passos, porque o segundo é
    // o que a pessoa encontra ao voltar do WhatsApp, e a do endereço, que é a mais
    // longa do app e a que mais sofre com o teclado.
    await clique('Meus dados');
    await foto('18-meus-dados');

    await tester.drag(find.byType(ListView).last, const Offset(0, -900));
    await tester.pumpAndSettle();
    await foto('18b-meus-dados-fim');

    await tester.drag(find.byType(ListView).last, const Offset(0, 900));
    await tester.pumpAndSettle();
    await clique('Alterar');
    await foto('18c-trocar-contato');
    await clique('Cancelar');

    await tester.drag(find.byType(ListView).last, const Offset(0, -300));
    await tester.pumpAndSettle();
    await clique('Rua das Flores, 120 — Apto 42');
    await foto('18d-endereco');
    await clique('Cancelar');
    await aoInicio();

    // ── meus documentos ───────────────────────────────────────────────────────
    //
    // A lista e a folha de um termo que falta aceitar — a única escrita da tela.
    await clique('Meus documentos');
    await foto('20-meus-documentos');

    await clique('Autorização de uso de imagem');
    await foto('20b-termo');
    await clique('Cancelar');
    await aoInicio();

    // ── e o mesmo app no escuro ───────────────────────────────────────────────
    //
    // O tema escuro não é o claro invertido: sombra some, borda desaparece e a cor da
    // marca precisa subir de clareza. É a metade do desenho que nenhum teste vê e que
    // o aparelho de quem usa liga sozinho às seis da tarde.
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    await tester.pumpAndSettle();
    await aoInicio();
    await foto('14-inicio-escuro');

    await clique('Meus agendamentos');
    await foto('15-agendamentos-escuro');
    await aoInicio();

    // O verde do crédito e o vermelho da dívida são as duas cores que o escuro mais
    // maltrata: um pastel de tema claro sobre grafite vira adesivo aceso.
    await clique('Minha conta');
    await foto('17-minha-conta-escuro');
    await aoInicio();

    await clique('Meus dados');
    await foto('19-meus-dados-escuro');
  });
}

Future<void> _carregar(String familia, List<String> arquivos) =>
    _carregarDe(familia, [for (final a in arquivos) 'assets/fonts/$a']);

Future<void> _carregarDe(String familia, List<String> caminhos) async {
  final carga = FontLoader(familia);
  for (final caminho in caminhos) {
    final bytes = File(caminho).readAsBytesSync();
    carga.addFont(Future.value(ByteData.view(Uint8List.fromList(bytes).buffer)));
  }
  await carga.load();
}

Sessao _sessao({required Armazenamento cofre}) => Sessao(
      armazenamento: cofre,
      clerk: ClerkFapi(
        host: 'exemplo.clerk.accounts.dev',
        armazenamento: CofreEmMemoria(),
        http_: MockClient((req) async => http.Response(
              jsonEncode({'jwt': 'token'}),
              200,
              headers: {'content-type': 'application/json'},
            )),
      ),
      http_: _portal,
    );

final _portal = MockClient((req) async {
  final rota = '${req.method} ${req.url.path}';
  Object? corpo;
  switch (rota) {
    case 'GET /public/v1/portal/tenants':
      corpo = {
        'tenants': [
          {
            'name': 'PetShop Amarillys',
            'slug': 'petshopamarillys',
            'logoUrl': null,
            'city': 'São Paulo',
          },
          {'name': 'Amigo Fiel', 'slug': 'amigofiel', 'logoUrl': null, 'city': null},
          {'name': 'Zoo Pet', 'slug': 'zoopet', 'logoUrl': null, 'city': null},
        ],
        'truncated': false,
      };
    case 'GET /portal/v1/tenant':
      corpo = _tenant;
    case 'GET /portal/v1/me':
      corpo = _me;
    case 'GET /portal/v1/pets':
      corpo = {'pets': [_resumo(_ficha), _resumo(_fiona)]};
    case 'GET /portal/v1/pets/pet-1':
      corpo = _ficha;
    case 'GET /portal/v1/pets/pet-1/timeline':
      corpo = _timeline;
    case 'GET /portal/v1/appointments':
      // Com cursor, a lista ganha o "Ver mais" — que é justamente a linha que o
      // aparelho mostrava por baixo da barra de navegação.
      corpo = req.url.queryParameters['cursor'] == null
          ? {
              'upcoming': [_proximo],
              'past': [_passado1, _passado2],
              'nextCursor': 'cursor-2',
              'timezone': _fuso,
            }
          : {
              'upcoming': [_proximo],
              'past': const [],
              'nextCursor': null,
              'timezone': _fuso,
            };
    case 'GET /portal/v1/booking/taxi':
      corpo = _oferta;
    case 'GET /portal/v1/booking/services':
      corpo = _servicos;
    case 'GET /portal/v1/booking/availability':
      corpo = _disponibilidade;
    case 'POST /portal/v1/booking':
      corpo = _criado;
    case 'POST /portal/v1/appointments/ag-1/cancel':
      corpo = _proximo;
    case 'GET /portal/v1/finance':
      corpo = _conta;
    case 'GET /portal/v1/finance/statement':
      corpo = _extrato;
    case 'GET /portal/v1/me/data':
      corpo = _meusDados;
    case 'GET /portal/v1/documents':
      corpo = _documentos;
    case 'GET /portal/v1/terms':
      corpo = _termos;
    default:
      return http.Response('{"detail":"rota nao dublada: $rota"}', 404,
          headers: {'content-type': 'application/json; charset=utf-8'});
  }
  return http.Response(jsonEncode(corpo), 200,
      headers: {'content-type': 'application/json'});
});

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
      'id': 'doc-2',
      'kind': 'RECEIPT',
      'number': 'REC-2026/000231',
      'issuedAt': '2026-09-18T15:02:00.000Z',
      'petName': null,
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
    {
      'id': 'doc-4',
      'kind': 'TERM_ACCEPTANCE',
      'number': 'TR-2026/000077',
      'issuedAt': '2026-08-02T12:00:00.000Z',
      'petName': null,
      'ready': true,
    },
  ],
};

const _termos = {
  'terms': [
    {
      'kind': 'SERVICE_LIABILITY',
      'title': 'Termo de responsabilidade',
      'version': '1.0',
      'body': '# Do serviço\n\nO tutor declara que o animal está em condições de receber o serviço.',
      'accepted': true,
      'acceptedVersion': '1.0',
    },
    {
      'kind': 'IMAGE_USE',
      'title': 'Autorização de uso de imagem',
      'version': '2.0',
      'body': '# Uso de imagem\n\nAutorizo o estabelecimento a publicar **fotos do meu pet** '
          'feitas durante o atendimento.\n\n- Nas redes sociais do estabelecimento\n'
          '- No site\n\nA autorização pode ser revogada a qualquer momento.',
      'accepted': false,
      'acceptedVersion': '1.0',
    },
  ],
};

const _fuso = 'America/Sao_Paulo';
const _prof = '3f1e0d2c-1111-4a2b-8c3d-000000000001';

const _tenant = {
  'name': 'PetShop Amarillys',
  'slug': 'petshopamarillys',
  'logoUrl': null,
  'brandColor': '#E34A32',
  'portalEnabled': true,
};

const _me = {
  'tenant': {
    'name': 'PetShop Amarillys',
    'slug': 'petshopamarillys',
    'logoUrl': null,
    'brandColor': '#E34A32',
    'timezone': _fuso,
  },
  'tutor': {'id': 'tutor-1', 'name': 'Mário Moraes', 'petsCount': 2, 'balanceCents': 0},
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
  'notes': 'Não gosta do secador alto.',
  'color': 'Branco',
  'weightKg': 8.5,
  'size': 'Pequeno',
  'coat': 'Encaracolado',
  'alerts': [
    {'kind': 'ALLERGY', 'label': 'shampoo neutro', 'severity': 'HIGH'},
  ],
};

const _fiona = {
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

const _proximo = {
  'id': 'ag-1',
  'status': 'CONFIRMED',
  'startsAt': '2026-09-28T13:00:00.000Z',
  'endsAt': '2026-09-28T14:00:00.000Z',
  'petId': 'pet-1',
  'petName': 'Marley',
  'professionalName': 'Marcelo',
  'services': ['Banho'],
  'totalCents': 9000,
  'awaitingApproval': true,
  'taxi': [
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
  ],
  'actions': {
    'canCancel': true,
    'canReschedule': true,
    'cancelIsLate': false,
    'cancelFeeCents': 0,
    'cancellationWindowHours': 24,
  },
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
  'status': 'COMPLETED',
  'startsAt': '2026-07-15T13:00:00.000Z',
  'endsAt': '2026-07-15T14:00:00.000Z',
  'petId': 'pet-1',
  'petName': 'Marley',
  'professionalName': 'Ana',
  'services': ['Banho', 'Hidratação'],
  'totalCents': 12000,
  'awaitingApproval': false,
  'taxi': [],
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
      'description': 'Higiênica ou na tesoura',
      'category': 'GROOMING',
      'priceCents': 7000,
      'durationMin': 45,
    },
  ],
};

const _disponibilidade = {
  'slots': [
    {
      'startsAt': '2026-09-30T13:00:00.000Z',
      'endsAt': '2026-09-30T14:00:00.000Z',
      'professionalId': _prof,
      'professionalName': 'Marcelo',
    },
    {
      'startsAt': '2026-09-30T14:00:00.000Z',
      'endsAt': '2026-09-30T15:00:00.000Z',
      'professionalId': _prof,
      'professionalName': 'Marcelo',
    },
    {
      'startsAt': '2026-09-30T16:30:00.000Z',
      'endsAt': '2026-09-30T17:30:00.000Z',
      'professionalId': _prof,
      'professionalName': 'Ana',
    },
    {
      'startsAt': '2026-09-30T18:00:00.000Z',
      'endsAt': '2026-09-30T19:00:00.000Z',
      'professionalId': _prof,
      'professionalName': 'Ana',
    },
  ],
  'nextAvailable': null,
  'durationMin': 60,
  'priceCents': 9000,
  'timezone': _fuso,
  'minNoticeHours': 2,
};

/// A oferta de leva-e-traz: **preço por perna**, e o endereço para onde a van vai.
const _oferta = {
  'available': true,
  'reason': null,
  'message': null,
  'address': {'label': 'Rua das Acácias, 120 — Pinheiros', 'zipCode': '05422-030'},
  'priceCentsPerLeg': 2500,
  'windowMinutes': 60,
};

/// O comprovante com as duas corridas: `totalCents` é só o do atendimento, e é a tela
/// que soma o transporte — é o que faz o número bater com o da confirmação.
const _criado = {
  'id': '9f1e0d2c-2222-4a2b-8c3d-000000000002',
  'status': 'CONFIRMED',
  'startsAt': '2026-09-30T13:00:00.000Z',
  'endsAt': '2026-09-30T14:00:00.000Z',
  'petName': 'Marley',
  'professionalName': 'Marcelo',
  'services': ['Banho'],
  'totalCents': 9000,
  'awaitingApproval': false,
  'duplicate': false,
  'taxi': [
    {
      'id': 'corrida-ida',
      'leg': 'PICKUP',
      'legLabel': 'Buscar em casa',
      'status': 'REQUESTED',
      'statusText': 'Aguardando o motorista',
      'windowStartsAt': '2026-09-30T12:00:00.000Z',
      'windowEndsAt': '2026-09-30T13:00:00.000Z',
      'priceCents': 2500,
    },
    {
      'id': 'corrida-volta',
      'leg': 'DROPOFF',
      'legLabel': 'Devolver em casa',
      'status': 'REQUESTED',
      'statusText': 'Aguardando o motorista',
      'windowStartsAt': '2026-09-30T14:00:00.000Z',
      'windowEndsAt': '2026-09-30T15:00:00.000Z',
      'priceCents': 2500,
    },
  ],
  'taxiWarning': null,
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

/// A conta com dívida: é o estado que tem mais tela — o saldo em vermelho, o bloco
/// "Como pagar" e a chave PIX, que a conta em dia não mostra.
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
    {
      'id': '3f1c8b2e-0000-4000-8000-000000000002',
      'name': 'Tosa higiênica — 2 sessões',
      'petName': 'Fiona',
      'creditsTotal': 2,
      'creditsRemaining': 1,
      'expiresAt': '2026-10-05T15:00:00.000Z',
      'expiringSoon': true,
    },
  ],
  'howToPay': {
    'pixKey': '4f2a91c3-8d7e-4b16-9a05-c3e8d7f10b24',
    'phone': '(11) 3333-1200',
    'whatsapp': '(11) 99999-0000',
    'hours': [
      {'label': 'Seg a Sex', 'value': '08:00 às 18:00'},
      {'label': 'Sábado', 'value': '08:00 às 13:00'},
    ],
  },
  'timezone': _fuso,
};

const _extrato = {
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
  'page': 1,
  'limit': 10,
  'total': 3,
  'balanceCents': -18000,
  'timezone': _fuso,
};

const _meusDados = {
  'profile': {
    'fullName': 'Mário Moraes',
    'socialName': 'Mário',
    'displayName': 'Mário',
    'cpfMasked': '***.598.588-**',
    'cnpjMasked': null,
    'phoneMasked': '(11) 9****-8801',
    'email': 'mario.moraes.cadastro.antigo@exemplo.com.br',
    'birthDate': '1990-04-12',
  },
  'addresses': [
    {
      'id': '5b0c6a55-1111-4222-8333-444455556666',
      'label': 'Casa',
      'zipCode': '01310100',
      'street': 'Rua das Flores',
      'number': '120',
      'complement': 'Apto 42',
      'district': 'Bela Vista',
      'city': 'São Paulo',
      'state': 'SP',
      'accessNotes': 'Portão azul, interfone 42.',
      'isPrimary': true,
    },
    {
      'id': '5b0c6a55-1111-4222-8333-444455556667',
      'label': 'Trabalho',
      'zipCode': '04538133',
      'street': 'Avenida Brigadeiro Faria Lima',
      'number': '3500',
      'complement': null,
      'district': 'Itaim Bibi',
      'city': 'São Paulo',
      'state': 'SP',
      'accessNotes': null,
      'isPrimary': false,
    },
  ],
  'pendingContact': null,
  'deletionRequest': null,
};
