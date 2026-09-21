import 'package:flutter/material.dart';

import '../../api/portal_api.dart';
import '../../api/portal_error.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';

/// A grade de horários de um dia, e as peças que respondem a ela.
///
/// Mora fora das duas telas que a usam — marcar e remarcar — porque é **a mesma
/// pergunta com os mesmos serviços**; o que muda é o destino da confirmação. Duas
/// versões disso divergiriam no dia em que a antecedência mínima passasse a filtrar
/// diferente, e a tela de remarcar ofereceria um horário que o POST recusa.

/// O que uma consulta de disponibilidade devolve, já pronto para a tela.
class ResultadoDaGrade {
  ResultadoDaGrade({
    required this.slots,
    required this.proximo,
    required this.fuso,
    required this.antecedenciaHoras,
  });

  final List<PortalSlot> slots;

  /// AC-02 do MOD-AGENDA-11: o dia vazio sem alternativa devolve o tutor ao telefone.
  final String? proximo;

  /// O fuso vem da **resposta**, e não de uma constante: é o do estabelecimento que
  /// respondeu a grade.
  final String fuso;

  final int antecedenciaHoras;
}

Future<ResultadoDaGrade> buscarGrade(
  PortalApi api, {
  required String petId,
  required List<String> serviceIds,
  required DateTime dia,
  required TenantTime tempo,
}) async {
  final resposta = await api.disponibilidade(
    petId: petId,
    serviceIds: serviceIds,
    dia: tempo.diaParaConsulta(dia),
  );
  return ResultadoDaGrade(
    slots: resposta.slots,
    proximo: resposta.nextAvailable,
    fuso: resposta.timezone,
    antecedenciaHoras: resposta.minNoticeHours,
  );
}

/// A grade do dia, em botões de hora.
class GradeDeHorarios extends StatelessWidget {
  const GradeDeHorarios({
    super.key,
    required this.horarios,
    required this.escolhido,
    required this.tempo,
    required this.carregando,
    required this.proximo,
    required this.antecedenciaHoras,
    required this.ehHoje,
    required this.aoEscolher,
  });

  final List<PortalSlot> horarios;
  final PortalSlot? escolhido;
  final TenantTime tempo;
  final bool carregando;
  final String? proximo;
  final int antecedenciaHoras;
  final bool ehHoje;
  final ValueChanged<PortalSlot> aoEscolher;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final cinza = tema.textTheme.bodySmall
        ?.copyWith(color: tema.colorScheme.onSurfaceVariant, height: 1.4);

    if (carregando) return Text('Procurando horários…', style: cinza);

    if (horarios.isEmpty) {
      return Text(
        proximo == null
            ? 'Não há horário disponível neste dia.'
            : 'Não há horário neste dia. O próximo disponível é '
                '${tempo.diaPorExtenso(proximo!)} às ${tempo.hora(proximo!)}.',
        style: cinza,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final slot in horarios)
              BotaoDeHora(
                rotulo: tempo.hora(slot.startsAt),
                // Dois profissionais livres na mesma hora são **dois** horários.
                // Comparar só pelo instante acenderia os dois botões de uma vez, sem
                // dizer qual deles está escolhido.
                marcado: escolhido?.startsAt == slot.startsAt &&
                    escolhido?.professionalId == slot.professionalId,
                aoTocar: () => aoEscolher(slot),
              ),
          ],
        ),
        // O número existe na resposta justamente para a tela poder explicar por que o
        // começo do dia sumiu — sem ele, a grade que começa às 14h parece defeito.
        if (ehHoje && antecedenciaHoras > 0)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              'Hoje aparecem só os horários com pelo menos ${antecedenciaHoras}h de '
              'antecedência.',
              style: cinza,
            ),
          ),
      ],
    );
  }
}

class BotaoDeHora extends StatelessWidget {
  const BotaoDeHora({
    super.key,
    required this.rotulo,
    required this.marcado,
    required this.aoTocar,
  });

  final String rotulo;
  final bool marcado;
  final VoidCallback aoTocar;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;
    final estilo = ButtonStyle(
      minimumSize: const WidgetStatePropertyAll(Size(72, 44)),
      padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 16)),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );

    if (marcado) {
      return FilledButton(onPressed: aoTocar, style: estilo, child: Text(rotulo));
    }
    return OutlinedButton(
      onPressed: aoTocar,
      style: estilo.copyWith(
        foregroundColor: WidgetStatePropertyAll(esquema.onSurface),
      ),
      child: Text(rotulo),
    );
  }
}

/// A recusa que aponta a saída.
///
/// Os horários alternativos vêm **no corpo do 409**: foi o servidor que os sondou, e a
/// tela não adivinha nenhum. Sem eles o tutor fica sabendo que não pode, e não fica
/// sabendo quando poderia.
class RecusaComAlternativas extends StatelessWidget {
  const RecusaComAlternativas({
    super.key,
    required this.falha,
    required this.tempo,
    required this.horarios,
    required this.aoEscolher,
    this.tituloPadrao = 'Não deu para marcar',
  });

  final PortalError falha;
  final TenantTime tempo;
  final List<PortalSlot> horarios;
  final ValueChanged<PortalSlot> aoEscolher;
  final String tituloPadrao;

  @override
  Widget build(BuildContext context) {
    final alertaClinico = falha.code == 'ERR_AGENDA_009';
    final alternativas = falha.alternativeStartsAt ?? const [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Aviso(
          erro: !alertaClinico,
          icone:
              alertaClinico ? Icons.warning_amber_outlined : Icons.event_busy_outlined,
          titulo: alertaClinico ? 'Atenção no atendimento' : tituloPadrao,
          texto: falha.message,
        ),
        if (alternativas.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final instante in alternativas)
                if (_slotDe(instante) case final slot?)
                  BotaoDeHora(
                    rotulo: tempo.hora(instante),
                    marcado: false,
                    aoTocar: () => aoEscolher(slot),
                  ),
            ],
          ),
        ],
      ],
    );
  }

  /// A alternativa só vira botão se existir na grade que está na tela: é de lá que sai
  /// o profissional, e um horário sem profissional não é um pedido válido.
  PortalSlot? _slotDe(String instante) =>
      horarios.where((slot) => slot.startsAt == instante).firstOrNull;
}
