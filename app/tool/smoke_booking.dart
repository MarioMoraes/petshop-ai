// Arnês de linha de comando: o lugar onde `print` é a saída, e não um resto de depuração.
// ignore_for_file: avoid_print

// O caminho de **escrita** da agenda, contra o backend de verdade: marcar, remarcar e
// cancelar.
//
// `smoke.dart` só lê, e por isso não prova a parte mais frágil: o corpo que os schemas
// `.strict()` aceitam e a **forma da resposta**. O formato do instante, o profissional
// que veio junto da vaga e o corte de nulos só se confirmam com um POST — e foi aqui
// que se descobriu que `POST /booking` não devolve `PortalAppointmentDetail`.
//
// **Ele cria e cancela.** As linhas ficam na agenda de desenvolvimento, e isso é o preço
// de provar a escrita; por isso ele marca os horários mais distantes que encontrar.
//
// **`--taxi` pede o leva-e-traz junto** (MOD-PORTAL-07). Fica atrás de um sinalizador
// porque cria corridas de verdade no painel do petshop, e porque só faz sentido num
// tenant com o módulo ligado e o tutor com endereço na área. O cancelamento do fim
// derruba as corridas junto, sem cobrança (AC-06), que é o que torna o ensaio limpo.
//
//   dart run tool/smoke_booking.dart <token> <slug> [baseUrl] [--taxi]
import 'dart:io';

import 'package:petshop_tutor/src/api/portal_api.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/api/portal_error.dart';
import 'package:petshop_tutor/src/models/portal_models.dart';
import 'package:petshop_tutor/src/time/tenant_time.dart';

Future<void> main(List<String> args) async {
  final comTaxi = args.contains('--taxi');
  args = args.where((a) => a != '--taxi').toList();
  if (args.length < 2) {
    stderr.writeln(
        'uso: dart run tool/smoke_booking.dart <token> <slug> [baseUrl] [--taxi]');
    exit(2);
  }
  final baseUrl = args.length > 2 ? args[2] : 'http://localhost:3000';

  await TenantTime.iniciar();
  final cliente = PortalClient(
    baseUrl: baseUrl,
    slug: args[1],
    token: () async => args[0],
  );
  final api = PortalApi(cliente);

  try {
    final me = await api.me();
    final tempo = TenantTime(me.tenant.timezone);
    print('${me.tenant.name} · fuso ${me.tenant.timezone}');

    if (!me.features.onlineBookingEnabled) {
      print('agendamento online desligado neste tenant: nada a provar.');
      exit(0);
    }

    final pets = (await api.pets()).where((pet) => !pet.inMemoriam).toList();
    if (pets.isEmpty) {
      print('sem pet agendável.');
      exit(1);
    }
    final pet = pets.first;
    print('pet: ${pet.name}');

    final servicos = await api.servicos(pet.id);
    if (servicos.services.isEmpty) {
      print('sem serviço agendável para o porte do pet.');
      exit(1);
    }
    final servico = servicos.services.first;
    print('serviço: ${servico.name} · ${servico.durationMin}min');

    // Longe o bastante para não disputar a agenda de hoje com ninguém.
    final dia = tempo.hoje.add(const Duration(days: 21));
    final grade = await api.disponibilidade(
      petId: pet.id,
      serviceIds: [servico.id],
      dia: tempo.diaParaConsulta(dia),
    );
    if (grade.slots.isEmpty) {
      print('nenhum horário em ${tempo.diaParaConsulta(dia)} '
          '(próximo: ${grade.nextAvailable ?? "—"}).');
      exit(1);
    }

    // O **último** horário do dia: o primeiro é o que a recepção mais usa.
    final vaga = grade.slots.last;
    print('vaga: ${vaga.startsAt} -> ${tempo.hora(vaga.startsAt)} '
        'com ${vaga.professionalName}');

    // A oferta antes do pedido, como na tela: é ela que diz se há o que pedir, e o
    // preço é **por perna** — quem pede só a ida paga metade.
    PortalBookingTaxi? taxi;
    if (comTaxi) {
      if (!me.features.taxiEnabled) {
        print('  --    leva-e-traz fora do plano deste tenant: pedido sem transporte.');
      } else {
        final oferta = await api.ofertaDeTaxi();
        if (!oferta.available) {
          print('  --    leva-e-traz indisponível (${oferta.reason?.name}): '
              '${oferta.message}');
        } else {
          print('  ok    GET /booking/taxi -> ${oferta.priceCentsPerLeg} c/perna · '
              'janela ${oferta.windowMinutes}min · ${oferta.address?.label}');
          taxi = PortalBookingTaxi(pickup: true, dropoff: true);
        }
      }
    }

    final marcado = await api.agendar(PortalBooking(
      petId: pet.id,
      serviceIds: [servico.id],
      startsAt: DateTime.parse(vaga.startsAt),
      professionalId: vaga.professionalId,
      acknowledgedAlerts: false,
      notes: null,
      taxi: taxi,
    ));
    print('  ok    POST /booking -> ${marcado.id} · ${marcado.status} · '
        'aguarda aprovação: ${marcado.awaitingApproval} · '
        'duplicado: ${marcado.duplicate}');
    print('        ${tempo.completo(marcado.startsAt)} · ${marcado.services.join(", ")}');

    // As duas linhas de `taxi_rides`, como o tutor as vê. É a forma que nenhum dublê
    // prova: `legLabel` e `statusText` vêm escritos pelo servidor, e a janela é a do
    // agendamento que acabou de nascer.
    if (taxi != null) {
      if (marcado.taxi.isEmpty) {
        print('  --    nenhuma corrida criada · aviso: ${marcado.taxiWarning ?? "—"}');
      } else {
        for (final corrida in marcado.taxi) {
          print('  ok    corrida ${corrida.legLabel} · ${corrida.statusText} · '
              '${corrida.priceCents} · entre ${tempo.hora(corrida.windowStartsAt)} '
              'e ${tempo.hora(corrida.windowEndsAt)}');
        }
      }
    }

    // A prova de que o instante não escorregou: o que voltou é o que foi pedido.
    if (marcado.startsAt != vaga.startsAt) {
      print('  FALHA o instante voltou diferente: ${marcado.startsAt}');
      exit(1);
    }

    // O detalhe é outra forma que a da criação, e é dele que a remarcação vive:
    // `serviceIds` só existe aqui.
    final detalhe = await api.agendamento(marcado.id);
    print('  ok    GET /appointments/:id -> serviços ${detalhe.serviceIds.length} · '
        'cancelável: ${detalhe.actions.canCancel} · '
        'remarcável: ${detalhe.actions.canReschedule}');

    // Remarcar: a mesma grade, outro dia.
    final outroDia = tempo.hoje.add(const Duration(days: 22));
    final outraGrade = await api.disponibilidade(
      petId: pet.id,
      serviceIds: detalhe.serviceIds,
      dia: tempo.diaParaConsulta(outroDia),
    );
    var alvo = marcado.id;
    if (outraGrade.slots.isEmpty) {
      print('  --    sem vaga em ${tempo.diaParaConsulta(outroDia)}: remarcação pulada.');
    } else {
      final nova = outraGrade.slots.last;
      final remarcado = await api.remarcar(
        marcado.id,
        PortalReschedule(
          startsAt: DateTime.parse(nova.startsAt),
          professionalId: nova.professionalId,
        ),
      );
      // A resposta é o agendamento **novo**: o anterior já é histórico.
      alvo = remarcado.id;
      print('  ok    POST /appointments/:id/reschedule -> ${remarcado.id} · '
          '${tempo.completo(remarcado.startsAt)}');
      if (remarcado.id == marcado.id) {
        print('  FALHA a remarcação devolveu o mesmo id; era para ser outro registro.');
        exit(1);
      }
    }

    final cancelado = await api.cancelar(alvo);
    print('  ok    POST /appointments/:id/cancel -> ${cancelado.status} · '
        'cancelado em ${cancelado.cancelledAt ?? "—"}');

    print('\ntudo verde.');
    exit(0);
  } on PortalError catch (e) {
    print('  FALHA ${e.status} ${e.code}: ${e.message}');
    if (e.extra.isNotEmpty) print('        extra: ${e.extra}');
    exit(1);
  } finally {
    cliente.fechar();
  }
}
