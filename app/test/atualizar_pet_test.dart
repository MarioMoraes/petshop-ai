import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:petshop_tutor/src/api/portal_api.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/models/portal_models.dart';

/// A guarda do lado **oposto** ao `semNulos`.
///
/// `UpdateOwnPetSchema` tem três campos `.nullable()` *e* `.optional()`: ali `null` quer
/// dizer **apague** e ausente quer dizer **não mexa**. O dia em que alguém passar este
/// corpo pelo `semNulos` — o reflexo certo em quase toda outra chamada —, limpar a data
/// de nascimento vira silêncio: a tela fecha dizendo que salvou e o valor antigo fica.
/// Um defeito que não dá erro, que é o pior tipo. Este teste é o que o impede.
void main() {
  late Map<String, dynamic> corpoEnviado;
  late String caminhoChamado;
  late String metodoUsado;

  PortalApi apiFalsa() {
    final http_ = MockClient((requisicao) async {
      metodoUsado = requisicao.method;
      caminhoChamado = requisicao.url.path;
      corpoEnviado = jsonDecode(requisicao.body) as Map<String, dynamic>;
      return http.Response(jsonEncode(_fichaDeResposta), 200,
          headers: {'content-type': 'application/json'});
    });

    return PortalApi(PortalClient(
      baseUrl: 'http://localhost:3000',
      slug: 'petshopteste',
      token: () async => 'jwt',
      http_: http_,
    ));
  }

  test('o campo limpo vai como null, e não some do corpo', () async {
    await apiFalsa().atualizarPet('pet-1', UpdateOwnPet(
      name: 'Bilu',
      birthDate: null,
      neutered: null,
      notes: null,
    ));

    expect(metodoUsado, 'PATCH');
    expect(caminhoChamado, '/portal/v1/pets/pet-1');
    expect(corpoEnviado.containsKey('birthDate'), isTrue);
    expect(corpoEnviado['birthDate'], isNull);
    expect(corpoEnviado['neutered'], isNull);
    expect(corpoEnviado['notes'], isNull);
    expect(corpoEnviado['name'], 'Bilu');
  });

  test('a data vai como dia de calendário, sem hora e sem fuso', () async {
    await apiFalsa().atualizarPet('pet-1', UpdateOwnPet(
      name: 'Bilu',
      birthDate: DateTime(2021, 3, 9),
      neutered: true,
      notes: 'Tem medo de secador',
    ));

    expect(corpoEnviado['birthDate'], '2021-03-09');
    expect(corpoEnviado['neutered'], isTrue);
  });

  test('a resposta é a ficha recarregada, com a idade já recalculada', () async {
    final ficha = await apiFalsa()
        .atualizarPet('pet-1', UpdateOwnPet(name: 'Bilu'));

    expect(ficha.name, 'Bilu');
    expect(ficha.ageLabel, '5 anos');
    expect(ficha.alerts.single.kind, PortalPetAlertKind.ALLERGY);
  });
}

/// O que `PATCH /portal/v1/pets/:petId` devolve: a ficha inteira, e não a linha mudada.
const _fichaDeResposta = {
  'id': 'pet-1',
  'name': 'Bilu',
  'species': 'Cachorro',
  'breed': 'Poodle',
  'ageLabel': '5 anos',
  'photoUrl': null,
  'inMemoriam': false,
  'lastAttendanceAt': '2026-09-01T13:00:00.000Z',
  'nextAppointment': null,
  'sex': 'MALE',
  'birthDate': '2021-03-09',
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
