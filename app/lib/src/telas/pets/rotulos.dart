import '../../models/portal_models.dart';

/// Os textos da ficha do pet, fora das telas — porque são regra de leitura, e regra se
/// testa sem pintar pixel.

/// `Cachorro · Poodle · 3 anos`, sem os que faltarem.
String descreverPet({String? especie, String? raca, String? idade}) =>
    [especie, raca, idade].where((p) => p != null && p.isNotEmpty).join(' · ');

String rotuloSexo(Sex sexo) => switch (sexo) {
      Sex.MALE => 'Macho',
      Sex.FEMALE => 'Fêmea',
      Sex.UNKNOWN => 'Não informado',
    };

/// `null` é **não sabemos**, e é diferente de "não".
///
/// A ficha que mostrasse "Não" para o desconhecido faria a equipe tratar como certo o
/// que ninguém perguntou — e castração é dado que muda conduta clínica.
String rotuloTernario(bool? valor) {
  if (valor == null) return 'Não informado';
  return valor ? 'Sim' : 'Não';
}

/// A data de nascimento **com a precisão junto**: `10/03/2021` ou `≈ 10/03/2021`.
///
/// O `≈` é o que separa o que o tutor afirmou do que o balcão estimou pela idade. Sem
/// ele, a tela apresenta um palpite com a cara de um documento.
String rotuloNascimento(String? data, BirthDatePrecision precisao) {
  if (data == null || data.isEmpty || precisao == BirthDatePrecision.UNKNOWN) {
    return 'Não informado';
  }
  final partes = data.split('-');
  if (partes.length != 3) return 'Não informado';
  final formatada = '${partes[2]}/${partes[1]}/${partes[0]}';
  return precisao == BirthDatePrecision.ESTIMATED ? '≈ $formatada' : formatada;
}

/// `12 kg` e `12,4 kg` — nunca `12.0 kg`.
///
/// O peso desce como número, e um `double` impresso cru põe a casa decimal que o balcão
/// não digitou. A vírgula é a do português, que é o idioma da tela.
String rotuloPeso(double? kg) {
  if (kg == null) return '—';
  final texto = kg == kg.roundToDouble()
      ? kg.toStringAsFixed(0)
      : kg.toString().replaceAll('.', ',');
  return '$texto kg';
}

/// O que o atendimento foi, quando nenhum item foi lançado nele.
///
/// Linha do tempo sem rótulo de reserva mostraria uma entrada muda no dia em que o tutor
/// levou o pet ali — e uma linha em branco lê como defeito da tela, não como registro
/// incompleto do balcão.
String rotuloTipoDeAtendimento(String tipo) => const {
      'GROOMING': 'Tosa',
      'BATH': 'Banho',
      'VET_CONSULT': 'Consulta veterinária',
      'VACCINE': 'Vacina',
      'PROCEDURE': 'Procedimento',
      'DAYCARE': 'Creche',
      'OTHER': 'Atendimento',
    }[tipo] ??
    'Atendimento';

/// A frase de um alerta clínico, do jeito que o dono do animal a lê.
///
/// A reação e as instruções ficam no servidor, cifradas: são texto escrito para a equipe
/// executar. O que o tutor precisa saber é que a alergia existe e quão séria ela é.
String rotuloAlerta(PortalPetAlert alerta) =>
    alerta.kind == PortalPetAlertKind.ALLERGY ? 'Alergia a ${alerta.label}' : alerta.label;
