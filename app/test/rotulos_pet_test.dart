import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/models/portal_models.dart';
import 'package:petshop_tutor/src/telas/pets/rotulos.dart';

/// Os textos da ficha são regra de leitura, e regra se testa sem pintar pixel.
void main() {
  test('a descrição pula o que falta, sem separador sobrando', () {
    expect(
      descreverPet(especie: 'Cachorro', raca: null, idade: '3 anos'),
      'Cachorro · 3 anos',
    );
    expect(descreverPet(especie: 'Gato'), 'Gato');
  });

  test('o desconhecido não vira "não"', () {
    expect(rotuloTernario(null), 'Não informado');
    expect(rotuloTernario(false), 'Não');
    expect(rotuloTernario(true), 'Sim');
  });

  test('a data estimada carrega o ≈ que a separa da informada', () {
    expect(rotuloNascimento('2021-03-09', BirthDatePrecision.EXACT), '09/03/2021');
    expect(rotuloNascimento('2021-03-09', BirthDatePrecision.ESTIMATED), '≈ 09/03/2021');
    // Precisão desconhecida some com a data: o servidor manda uma, mas ela é chute.
    expect(rotuloNascimento('2021-03-09', BirthDatePrecision.UNKNOWN), 'Não informado');
    expect(rotuloNascimento(null, BirthDatePrecision.EXACT), 'Não informado');
  });

  test('o peso não inventa casa decimal', () {
    expect(rotuloPeso(8), '8 kg');
    expect(rotuloPeso(8.5), '8,5 kg');
    expect(rotuloPeso(null), '—');
  });

  test('o atendimento sem item lançado ainda diz o que foi', () {
    expect(rotuloTipoDeAtendimento('BATH'), 'Banho');
    expect(rotuloTipoDeAtendimento('ALGO_NOVO_NO_BACKEND'), 'Atendimento');
  });

  test('a alergia se anuncia como alergia; o alerta médico fala por si', () {
    expect(
      rotuloAlerta(PortalPetAlert(
          kind: PortalPetAlertKind.ALLERGY, label: 'frango', severity: Severity.LOW)),
      'Alergia a frango',
    );
    expect(
      rotuloAlerta(PortalPetAlert(
          kind: PortalPetAlertKind.MEDICAL,
          label: 'Cardiopatia',
          severity: Severity.CRITICAL)),
      'Cardiopatia',
    );
  });
}
