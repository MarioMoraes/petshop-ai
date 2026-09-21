import 'package:flutter/material.dart';

import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';

/// Cancelar um horário (AC-02 e AC-03 de MOD-PORTAL-06).
///
/// **A consequência é mostrada antes, e quem confirma é a pessoa.** O diálogo abre com o
/// valor da taxa quando o cancelamento é tardio, e só então manda `acknowledgeFee` —
/// que é o mesmo desenho do `acknowledgedAlerts` do agendamento.
///
/// E o servidor ainda recusa a primeira tentativa se ela chegar sem o reconhecimento,
/// **mesmo quando a tela já avisou**: a tela pode estar velha — o tutor deixou o app
/// aberto e a janela de 24h fechou enquanto isso —, e a regra não. Por isso o
/// `ERR_PORTAL_011` também tem tratamento aqui: ele traz `feeCents` no corpo, e o
/// diálogo se corrige com o número do servidor em vez de insistir com o que tinha.
///
/// Devolve `true` quando cancelou.
Future<bool> abrirCancelamento(
  BuildContext context,
  Sessao sessao,
  PortalUpcomingAppointment agendamento,
  TenantTime tempo,
) async {
  final cancelou = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => _Cancelamento(
      sessao: sessao,
      agendamento: agendamento,
      tempo: tempo,
    ),
  );
  return cancelou ?? false;
}

class _Cancelamento extends StatefulWidget {
  const _Cancelamento({
    required this.sessao,
    required this.agendamento,
    required this.tempo,
  });

  final Sessao sessao;
  final PortalUpcomingAppointment agendamento;
  final TenantTime tempo;

  @override
  State<_Cancelamento> createState() => _CancelamentoState();
}

class _CancelamentoState extends State<_Cancelamento> {
  bool _cancelando = false;
  String? _erro;

  /// A taxa, e de onde ela veio.
  ///
  /// Começa no que `actions` disse; se o servidor recusar com um número, passa a ser o
  /// dele — e o diálogo volta a pedir confirmação, agora dizendo o preço certo.
  late bool _tardio = widget.agendamento.actions.cancelIsLate;
  late int _taxaCents = widget.agendamento.actions.cancelFeeCents;
  late int _janelaHoras = widget.agendamento.actions.cancellationWindowHours;

  Future<void> _confirmar() async {
    setState(() {
      _cancelando = true;
      _erro = null;
    });

    try {
      await widget.sessao.api.cancelar(
        widget.agendamento.id,
        aceitarTaxa: _tardio && _taxaCents > 0,
      );
      if (mounted) Navigator.of(context).pop(true);
    } on PortalError catch (e) {
      if (!mounted) return;
      if (e.code == 'ERR_PORTAL_011') {
        // O servidor sabe mais do que a tela sabia. Não cancela às escondidas: mostra o
        // número dele e espera o segundo toque.
        setState(() {
          _tardio = true;
          _taxaCents = e.feeCents ?? _taxaCents;
          _janelaHoras = e.extra['cancellationWindowHours'] as int? ?? _janelaHoras;
          _erro = null;
        });
        return;
      }
      setState(() => _erro = e.message);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _cancelando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final agendamento = widget.agendamento;
    final comTaxa = _tardio && _taxaCents > 0;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Cancelar este horário?',
                style: tema.textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(
              '${widget.tempo.diaPorExtenso(agendamento.startsAt)} às '
              '${widget.tempo.hora(agendamento.startsAt)}\n'
              '${agendamento.petName} · ${agendamento.services.join(', ')}',
              style: tema.textTheme.bodyMedium?.copyWith(
                color: tema.colorScheme.onSurfaceVariant,
                height: 1.45,
              ),
            ),
            const SizedBox(height: 18),

            Aviso(
              erro: comTaxa,
              icone: comTaxa ? Icons.payments_outlined : Icons.event_available_outlined,
              texto: comTaxa
                  ? 'Faltam menos de ${_janelaHoras}h para o horário. Cancelar agora '
                      'gera uma taxa de ${reais(_taxaCents)}, que entra na sua conta '
                      'com o estabelecimento.'
                  : 'O horário volta para a agenda do estabelecimento e não há '
                      'nenhuma taxa.',
            ),

            // AC-06 de MOD-PORTAL-07: as corridas caem junto, e não se cobram. Dizer
            // isso aqui evita a pergunta seguinte — "e o leva-e-traz, continua?" — que
            // hoje vira telefonema.
            if (agendamento.taxi.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                'O leva-e-traz deste horário é cancelado junto, sem cobrança.',
                style: tema.textTheme.bodySmall
                    ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
              ),
            ],

            if (_erro != null) ...[
              const SizedBox(height: 14),
              Aviso(texto: _erro!, erro: true),
            ],

            const SizedBox(height: 20),
            BotaoPrincipal(
              rotulo: 'Cancelar mesmo assim',
              rotuloOcupado: 'Cancelando…',
              ocupado: _cancelando,
              onPressed: _confirmar,
            ),
            const SizedBox(height: 8),
            // `ghost` só para desistir, ao lado da ação que grava — e o texto diz o que
            // acontece, não "Cancelar", que aqui seria a mesma palavra para as duas
            // coisas opostas.
            TextButton(
              onPressed:
                  _cancelando ? null : () => Navigator.of(context).pop(false),
              child: const Text('Manter horário'),
            ),
          ],
        ),
      ),
    );
  }
}
