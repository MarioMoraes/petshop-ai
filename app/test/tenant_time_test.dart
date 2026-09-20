import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/time/tenant_time.dart';

/// A guarda contra a regressão mais cara deste app.
///
/// O backend manda todo instante em UTC. Formatar com o fuso do aparelho passa
/// despercebido na máquina de quem desenvolve — que está no mesmo fuso do petshop — e
/// mostra a hora errada para quem viajou. Estes testes fixam a tradução.
void main() {
  setUpAll(TenantTime.iniciar);

  test('traduz UTC para a hora do estabelecimento', () {
    final tempo = TenantTime('America/Sao_Paulo');
    // O caso real medido contra o backend: a grade desce 13:00Z para um banho às 10h.
    expect(tempo.hora('2026-09-22T13:00:00.000Z'), '10:00');
    expect(tempo.diaCurto('2026-09-22T13:00:00.000Z'), '22/09');
    expect(tempo.completo('2026-09-22T13:00:00.000Z'), '22/09/2026 às 10:00');
  });

  test('o mesmo instante muda de dia conforme o fuso', () {
    const instante = '2026-09-23T02:00:00.000Z';
    expect(TenantTime('America/Sao_Paulo').diaCurto(instante), '22/09');
    expect(TenantTime('America/Manaus').diaCurto(instante), '22/09');
    expect(TenantTime('Europe/Lisbon').diaCurto(instante), '23/09');
  });

  test('fuso desconhecido não derruba a tela', () {
    expect(TenantTime('Marte/Olympus').hora('2026-09-22T13:00:00.000Z'), '10:00');
  });

  test('o dia da consulta sai no formato que a rota espera', () {
    final tempo = TenantTime('America/Sao_Paulo');
    expect(tempo.diaParaConsulta(DateTime(2026, 9, 7)), '2026-09-07');
  });
}
