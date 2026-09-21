// Arnês de linha de comando: o lugar onde `print` é a saída, e não um resto de depuração.
// ignore_for_file: avoid_print

// Arnês de fumaça: o cliente e os modelos gerados contra o backend em execução.
//
// Não é teste de unidade — é a pergunta que só o servidor responde: as classes geradas
// a partir do Zod **aceitam** o JSON que as rotas realmente devolvem? Um modelo que erra
// um campo opcional passa no `flutter analyze` e só estoura na tela.
//
//   dart run tool/smoke.dart <token> <slug> [baseUrl]
import 'dart:io';

import 'package:petshop_tutor/src/api/portal_api.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/api/portal_error.dart';
import 'package:petshop_tutor/src/time/tenant_time.dart';

int falhas = 0;

Future<void> passo(String nome, Future<void> Function() corpo) async {
  try {
    await corpo();
    print('  ok    $nome');
  } on PortalError catch (e) {
    falhas++;
    print('  FALHA $nome -> ${e.status} ${e.code}: ${e.message}');
  } catch (e) {
    falhas++;
    print('  FALHA $nome -> $e');
  }
}

Future<void> main(List<String> args) async {
  if (args.length < 2) {
    stderr.writeln('uso: dart run tool/smoke.dart <token> <slug> [baseUrl]');
    exit(2);
  }
  final token = args[0];
  final slug = args[1];
  final baseUrl = args.length > 2 ? args[2] : 'http://localhost:3000';

  await TenantTime.iniciar();

  final cliente = PortalClient(baseUrl: baseUrl, slug: slug, token: () async => token);
  final api = PortalApi(cliente);

  print('Portal em $baseUrl, petshop "$slug"\n');

  await passo('GET /public/v1/portal/tenants (sem petshop nenhum)', () async {
    // O catálogo é a única chamada anterior à escolha: vai sem o header do slug, por um
    // cliente que não tem slug para mandar.
    final semPetshop = PortalClient.semPetshop(baseUrl: baseUrl);
    final catalogo = await PortalApi(semPetshop).estabelecimentos();
    semPetshop.fechar();
    print('        ${catalogo.tenants.length} estabelecimento(s)'
        '${catalogo.truncated ? " (lista cortada)" : ""}');
    for (final item in catalogo.tenants.take(5)) {
      print('        ${item.name} (${item.slug})');
    }
  });

  await passo('GET /tenant (anônimo)', () async {
    final t = await api.tenant();
    print('        ${t.name} · portal ${t.portalEnabled ? "ligado" : "desligado"}');
  });

  String? petId;
  String? fuso;

  await passo('GET /me', () async {
    final me = await api.me();
    fuso = me.tenant.timezone;
    print('        ${me.tutor.name} · ${me.tutor.petsCount} pet(s) · fuso $fuso');
    print('        agendamento online: ${me.features.onlineBookingEnabled} · '
        'táxi: ${me.features.taxiEnabled}');
  });

  await passo('GET /pets', () async {
    final pets = await api.pets();
    petId = pets.isEmpty ? null : pets.first.id;
    for (final p in pets) {
      print('        ${p.name} (${p.species}) · ${p.ageLabel}');
    }
  });

  if (petId == null) {
    print('\nsem pet para seguir: as chamadas seguintes precisam de um.');
    exit(falhas == 0 ? 0 : 1);
  }

  await passo('GET /pets/:id', () async => api.pet(petId!));

  await passo('GET /pets/:id/timeline', () async {
    final t = await api.timeline(petId!);
    print('        ${t.entries.length} entrada(s), cursor ${t.nextCursor ?? "—"}');
  });

  var servicos = <String>[];
  await passo('GET /booking/services', () async {
    final r = await api.servicos(petId!);
    servicos = r.services.map((s) => s.id).toList();
    for (final s in r.services) {
      print('        ${s.name} · ${s.durationMin}min · R\$ ${s.priceCents / 100}');
    }
  });

  if (servicos.isNotEmpty && fuso != null) {
    final tempo = TenantTime(fuso!);
    final dia = tempo.diaParaConsulta(tempo.hoje.add(const Duration(days: 2)));
    await passo('GET /booking/availability ($dia)', () async {
      final d = await api.disponibilidade(
        petId: petId!,
        serviceIds: [servicos.first],
        dia: dia,
      );
      print('        ${d.slots.length} horário(s) · antecedência mín. '
          '${d.minNoticeHours}h · fuso ${d.timezone}');
      for (final s in d.slots.take(3)) {
        // A prova do fuso: o servidor manda UTC, a tela mostra a hora do petshop.
        print('        ${s.startsAt}  ->  ${tempo.hora(s.startsAt)} com ${s.professionalName}');
      }
    });
  }

  await passo('GET /booking/taxi', () async {
    final o = await api.ofertaDeTaxi(petId!);
    print('        disponível: ${o.available}');
  });

  await passo('GET /appointments', () async {
    final a = await api.agendamentos(limite: 5);
    final tempo = TenantTime(a.timezone);
    print('        ${a.upcoming.length} futuro(s), ${a.past.length} passado(s)');
    for (final ag in a.upcoming) {
      print('        ${tempo.completo(ag.startsAt)} · ${ag.petName} · '
          '${ag.services.join(", ")} · cancelável: ${ag.actions.canCancel}');
    }
  });

  cliente.fechar();
  print(falhas == 0 ? '\ntudo verde.' : '\n$falhas falha(s).');
  exit(falhas == 0 ? 0 : 1);
}
