import 'package:flutter/material.dart';

import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/listas.dart';
import '../../ui/tema.dart';

/// Quantos dias antes do vencimento a dose passa a "vencer em breve". O mesmo
/// `VACCINATION_DUE_SOON_DAYS` da web.
const _diasDeAntecedencia = 30;

/// A carteira de vacinação do pet (MOD-PRONT-08).
///
/// A dose **vigente** de cada vacina, com a data da próxima: o tutor abre isto para saber
/// se a antirrábica está em dia, e as doses antigas só repetiriam a mesma vacina com
/// datas velhas.
///
/// As datas vêm como dia, sem hora (`YYYY-MM-DD`), e são lidas pelos campos de dia, mês e
/// ano — nunca convertidas de fuso, que empurraria a vacina para a véspera. "Hoje" é o do
/// petshop, que o servidor manda junto: é contra ele que "atrasada" se decide.
class CarteiraDeVacinas extends StatelessWidget {
  const CarteiraDeVacinas({super.key, required this.carteira});

  final PortalVaccinationCard carteira;

  @override
  Widget build(BuildContext context) {
    final cabecalho = CabecalhoDeSecao(
      icone: Icons.vaccines_outlined,
      base: Tons.pet,
      titulo: 'Carteira de Vacinação',
      descricao: carteira.current.isEmpty
          ? 'Nenhuma vacina registrada ainda. Leve a carteira de papel no próximo '
              'atendimento e a equipe a transcreve aqui.'
          : null,
    );

    return PilhaDeLinhas(
      cabecalho: cabecalho,
      filhos: [
        for (final dose in carteira.current) _Dose(dose: dose, hoje: carteira.today),
      ],
    );
  }
}

class _Dose extends StatelessWidget {
  const _Dose({required this.dose, required this.hoje});

  final PortalVaccination dose;
  final DateTime hoje;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final proxima = dose.nextDoseAt;
    final atrasada = proxima != null && proxima.isBefore(hoje);
    final emBreve = !atrasada &&
        proxima != null &&
        !proxima.isAfter(hoje.add(const Duration(days: _diasDeAntecedencia)));

    final detalhe = [
      dose.vetName,
      dose.externalClinic,
      if (dose.batch != null) 'lote ${dose.batch}',
    ].whereType<String>().join(' · ');

    return Linha(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                dose.vaccineLabel,
                style: tema.textTheme.titleSmall?.copyWith(fontSize: 15, color: t.tinta),
              ),
              if (atrasada) const Selo(texto: 'Atrasada', erro: true),
              if (emBreve) const Selo(texto: 'Vence em Breve', tom: TomDoSelo.marca),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            'Aplicada em ${_data(dose.appliedAt)}'
            '${proxima != null ? ' · próxima dose em ${_data(proxima)}' : ' · dose única'}',
            style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
          ),
          if (detalhe.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detalhe,
                style: tema.textTheme.labelSmall?.copyWith(color: t.discreta),
              ),
            ),
        ],
      ),
    );
  }
}

/// "Vacinação atrasada: V10 (Polivalente), vencida há 45 dias" — o mesmo texto da web
/// (`overdueMessage` em `shared-types/src/vaccination.ts`).
String? avisoDeVacinaAtrasada(PortalVaccinationCard carteira) {
  final atrasadas = carteira.current
      .where((d) => d.nextDoseAt != null && d.nextDoseAt!.isBefore(carteira.today))
      .toList()
    ..sort((a, b) => a.nextDoseAt!.compareTo(b.nextDoseAt!));
  if (atrasadas.isEmpty) return null;

  final primeira = atrasadas.first;
  final dias = carteira.today.difference(primeira.nextDoseAt!).inDays;
  final quanto = dias == 1 ? '1 dia' : '$dias dias';
  final outras = atrasadas.length > 1 ? ' e mais ${atrasadas.length - 1}' : '';
  return 'Vacinação atrasada: ${primeira.vaccineLabel}, vencida há $quanto$outras';
}

String _data(DateTime dia) =>
    '${dia.day.toString().padLeft(2, '0')}/${dia.month.toString().padLeft(2, '0')}/${dia.year}';
