import 'package:flutter/material.dart';

import '../../api/portal_api.dart';
import '../../api/portal_error.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/tema.dart';

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
    final t = context.tokens;
    final cinza = tema.textTheme.bodySmall?.copyWith(height: 1.5);

    // A espera ganha o anel junto da frase: a grade some por inteiro enquanto a busca
    // está em voo, e uma linha de texto sozinha no lugar dela parece resposta.
    if (carregando) {
      return Row(
        children: [
          const Girando(tamanho: 17),
          const SizedBox(width: 10),
          Expanded(child: Text('Procurando horários…', style: cinza)),
        ],
      );
    }

    if (horarios.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: t.chip,
          borderRadius: BorderRadius.circular(Raio.controle),
          border: Border.all(color: t.linha),
        ),
        child: Text(
          proximo == null
              ? 'Não há horário disponível neste dia.'
              : 'Não há horário neste dia. O próximo disponível é '
                  '${tempo.diaPorExtenso(proximo!)} às ${tempo.hora(proximo!)}.',
          style: cinza,
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 9,
          runSpacing: 9,
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

/// Uma vaga da grade.
///
/// A escolhida fica **escura e com sombra**, e não só com a borda mais grossa: numa
/// malha de doze pílulas iguais, a diferença de uma borda não sobrevive ao polegar em
/// cima. É a mesma peça escura que o resto do app usa para dizer "este aqui".
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
    final t = context.tokens;
    final forma = BorderRadius.circular(Raio.controle);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: aoTocar,
        borderRadius: forma,
        // **Sem `alignment` aqui.** Um `Container` com alinhamento se estica até o
        // limite que recebe, e dentro do `Wrap` esse limite é a largura do cartão: a
        // grade virava uma pilha de botões de largura inteira, um por linha, em vez da
        // malha de pílulas. O alinhamento vertical fica no `Center` de dentro, que só
        // ocupa a largura do próprio texto (`widthFactor: 1`).
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          height: 46,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: BoxDecoration(
            gradient: marcado ? t.gradienteDoBotao : null,
            color: marcado ? null : t.cartao,
            borderRadius: forma,
            border: Border.all(color: marcado ? Colors.transparent : t.linha),
            boxShadow: marcado ? t.sombraDoBotao : null,
          ),
          child: Center(
            widthFactor: 1,
            child: Text(
              rotulo,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: marcado ? t.sobreBotao : t.tinta,
              ),
            ),
          ),
        ),
      ),
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
    this.rodape,
  });

  final PortalError falha;
  final TenantTime tempo;
  final List<PortalSlot> horarios;
  final ValueChanged<PortalSlot> aoEscolher;
  final String tituloPadrao;

  /// A saída que **esta** recusa tem e as outras não.
  ///
  /// Nasceu para a falta de vaga no leva-e-traz (AC-04 de MOD-PORTAL-07): ali, além dos
  /// horários alternativos, existe um segundo caminho — marcar o banho sem o transporte.
  /// Perder o atendimento por causa da van é o pior desfecho possível, e um toque é o
  /// que separa o tutor dele.
  final Widget? rodape;

  @override
  Widget build(BuildContext context) {
    final alertaClinico = falha.code == 'ERR_AGENDA_009';
    final alternativas = falha.alternativeStartsAt ?? const [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Aviso(
          erro: !alertaClinico,
          tom: alertaClinico ? TomDoAviso.marca : null,
          icone:
              alertaClinico ? Icons.warning_amber_rounded : Icons.event_busy_rounded,
          titulo: alertaClinico ? 'Atenção no atendimento' : tituloPadrao,
          texto: falha.message,
        ),
        if (alternativas.isNotEmpty) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 9,
            runSpacing: 9,
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
        if (rodape != null) ...[
          const SizedBox(height: 12),
          rodape!,
        ],
      ],
    );
  }

  /// A alternativa só vira botão se existir na grade que está na tela: é de lá que sai
  /// o profissional, e um horário sem profissional não é um pedido válido.
  PortalSlot? _slotDe(String instante) =>
      horarios.where((slot) => slot.startsAt == instante).firstOrNull;
}
