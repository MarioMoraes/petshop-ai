import 'package:flutter/material.dart';

import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../agendar/marcar_horario.dart';
import 'cancelar.dart';
import 'remarcar.dart';

/// Meus agendamentos (MOD-PORTAL-06).
///
/// **Duas seções numa tela só, e não duas abas.** O tutor típico tem dois compromissos
/// futuros e uma dúzia de passados; uma aba esconderia metade do conteúdo atrás de um
/// toque para separar coisas que ninguém confunde — o que já aconteceu está no passado,
/// e está escrito na data.
///
/// O futuro vem inteiro e o passado paginado, como o servidor manda: quem tem trinta
/// horários marcados não existe, e cortar essa lista esconderia o de dezembro.
class ListaDeAgendamentos extends StatelessWidget {
  const ListaDeAgendamentos({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final contexto = sessao.contexto!;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Meus agendamentos'),
        actions: [
          if (contexto.features.onlineBookingEnabled)
            Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  await Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => MarcarHorario(sessao: sessao)),
                  );
                  if (context.mounted) Recarregavel.de(context)?.call();
                },
                child: const Text('Marcar'),
              ),
            ),
        ],
      ),
      body: CarregarDados<PortalAppointmentsResponse>(
        buscar: () => sessao.api.agendamentos(limite: 10),
        construir: (context, agenda, recarregar) => Recarregavel(
          recarregar: recarregar,
          child: _Lista(sessao: sessao, inicial: agenda, recarregar: recarregar),
        ),
      ),
    );
  }
}

/// Quem sabe pedir a lista de novo, para quem está abaixo dela na árvore.
///
/// Existe porque o botão "Marcar" mora na barra do topo — fora do corpo que o
/// `CarregarDados` constrói — e, quando o tutor volta de lá com um horário novo, a lista
/// precisa deixar de mentir.
class Recarregavel extends InheritedWidget {
  const Recarregavel({super.key, required this.recarregar, required super.child});

  final Future<void> Function() recarregar;

  static Future<void> Function()? de(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<Recarregavel>()?.recarregar;

  @override
  bool updateShouldNotify(Recarregavel anterior) => false;
}

class _Lista extends StatefulWidget {
  const _Lista({
    required this.sessao,
    required this.inicial,
    required this.recarregar,
  });

  final Sessao sessao;
  final PortalAppointmentsResponse inicial;
  final Future<void> Function() recarregar;

  @override
  State<_Lista> createState() => _ListaState();
}

class _ListaState extends State<_Lista> {
  late List<PortalAppointment> _passados = [...widget.inicial.past];
  late String? _cursor = widget.inicial.nextCursor;
  bool _carregando = false;
  String? _erro;

  /// A lista recarregada traz uma primeira página nova, e as páginas já pedidas vêm
  /// dentro dela — continuar acrescentando sobre a lista antiga duplicaria cada linha.
  @override
  void didUpdateWidget(_Lista anterior) {
    super.didUpdateWidget(anterior);
    if (!identical(widget.inicial, anterior.inicial)) {
      _passados = [...widget.inicial.past];
      _cursor = widget.inicial.nextCursor;
      _erro = null;
    }
  }

  Future<void> _mais() async {
    final cursor = _cursor;
    if (cursor == null || _carregando) return;

    setState(() {
      _carregando = true;
      _erro = null;
    });
    try {
      final pagina = await widget.sessao.api.agendamentos(cursor: cursor, limite: 10);
      if (!mounted) return;
      setState(() {
        // **Só o passado é acrescentado.** A rota ignora o cursor para o bloco dos
        // próximos e devolve os mesmos em toda página — juntar os dois aqui faria o
        // compromisso de sexta aparecer duas vezes a cada "ver mais".
        _passados = [..._passados, ...pagina.past];
        _cursor = pagina.nextCursor;
      });
    } on PortalError catch (e) {
      if (mounted) setState(() => _erro = e.message);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _carregando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final tempo = TenantTime(widget.inicial.timezone);
    final proximos = widget.inicial.upcoming;
    final contexto = widget.sessao.contexto!;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        if (proximos.isEmpty && _passados.isEmpty)
          EstadoVazio(
            icone: Icons.calendar_month_outlined,
            titulo: 'Nenhum horário por aqui',
            descricao: contexto.features.onlineBookingEnabled
                ? 'Quando você marcar um horário, ele aparece nesta tela.'
                : 'Fale com o ${contexto.tenant.name} para marcar o horário do seu pet.',
          ),

        if (proximos.isNotEmpty) ...[
          Text('PRÓXIMOS',
              style: tema.textTheme.labelMedium?.copyWith(
                color: tema.colorScheme.onSurfaceVariant,
                letterSpacing: 1.1,
                fontWeight: FontWeight.w700,
              )),
          const SizedBox(height: 10),
          // Cada próximo é **um cartão**, e não uma linha de pilha: carrega selo,
          // botões e o leva-e-traz. Espremer isso numa linha faria a lista virar cartão
          // de qualquer jeito, só que sem o respiro entre um compromisso e o outro.
          for (final agendamento in proximos) ...[
            _CartaoDoProximo(
              sessao: widget.sessao,
              agendamento: agendamento,
              tempo: tempo,
              recarregar: widget.recarregar,
            ),
            const SizedBox(height: 12),
          ],
          const SizedBox(height: 16),
        ],

        if (_passados.isNotEmpty)
          PilhaDeLinhas(
            // "Histórico", e não "já aconteceram": o cancelado de sexta que vem cai
            // nesta seção e ainda não aconteceu. O rótulo precisa caber nos dois.
            cabecalho: const CabecalhoDeSecao(
              icone: Icons.calendar_month_outlined,
              titulo: 'Histórico',
            ),
            filhos: [
              for (final agendamento in _passados)
                _LinhaDoPassado(agendamento: agendamento, tempo: tempo),
            ],
            rodape: _erro != null || _cursor != null
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (_erro != null) ...[
                        Text(_erro!,
                            style: TextStyle(color: tema.colorScheme.error, fontSize: 13)),
                        const SizedBox(height: 8),
                      ],
                      if (_cursor != null)
                        OutlinedButton(
                          onPressed: _carregando ? null : _mais,
                          child: Text(_carregando ? 'Carregando…' : 'Ver mais'),
                        ),
                    ],
                  )
                : null,
          ),
      ],
    );
  }
}

/// Um agendamento futuro, com o que dá para fazer com ele.
///
/// **Os botões vêm do servidor.** `actions` diz se cabe cancelar, se cabe remarcar e
/// quanto custaria cancelar agora — a janela é configuração do petshop e muda sem que
/// ninguém publique app nenhum. Uma tela que decidisse isso sozinha mostraria "Cancelar"
/// para quem já está com o pet no banho.
class _CartaoDoProximo extends StatelessWidget {
  const _CartaoDoProximo({
    required this.sessao,
    required this.agendamento,
    required this.tempo,
    required this.recarregar,
  });

  final Sessao sessao;
  final PortalUpcomingAppointment agendamento;
  final TenantTime tempo;
  final Future<void> Function() recarregar;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final acoes = agendamento.actions;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 34,
                  height: 34,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: tema.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(Icons.calendar_month_outlined,
                      size: 18, color: tema.colorScheme.onPrimaryContainer),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // O selo vem **antes** da data, e sozinho na linha: ao lado dela
                      // roubava metade da largura do celular e quebrava
                      // "Sexta-feira, 12 de setembro" em cinco linhas.
                      if (agendamento.awaitingApproval) ...[
                        const Selo(texto: 'Aguardando confirmação'),
                        const SizedBox(height: 6),
                      ],
                      Text(
                        _comMaiuscula('${tempo.diaPorExtenso(agendamento.startsAt)} '
                            'às ${tempo.hora(agendamento.startsAt)}'),
                        style: tema.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 2),
                      Text('${agendamento.petName} · ${agendamento.services.join(', ')}',
                          style: tema.textTheme.bodySmall
                              ?.copyWith(color: tema.colorScheme.onSurfaceVariant)),
                      Text('com ${agendamento.professionalName}',
                          style: tema.textTheme.bodySmall
                              ?.copyWith(color: tema.colorScheme.onSurfaceVariant)),
                    ],
                  ),
                ),
              ],
            ),

            _FaixaDoTaxi(corridas: agendamento.taxi, tempo: tempo),

            // O valor e o que dá para fazer descem para um rodapé com fio: acima dele
            // fica o que o compromisso **é**, abaixo o que ele **custa** e o que se pode
            // mudar. Sem a divisão, o preço lia como mais uma legenda do pet.
            const SizedBox(height: 14),
            Divider(color: tema.colorScheme.outlineVariant.withValues(alpha: 0.6)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(reais(agendamento.totalCents),
                      style: tema.textTheme.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w700)),
                ),
                if (acoes.canReschedule)
                  TextButton(
                    onPressed: () async {
                      final remarcou = await Navigator.of(context).push<bool>(
                        MaterialPageRoute(
                          builder: (_) => Remarcar(
                            sessao: sessao,
                            agendamentoId: agendamento.id,
                          ),
                        ),
                      );
                      if (remarcou == true) await recarregar();
                    },
                    child: const Text('Remarcar'),
                  ),
                if (acoes.canCancel)
                  TextButton(
                    onPressed: () async {
                      final cancelou = await abrirCancelamento(
                        context,
                        sessao,
                        agendamento,
                        tempo,
                      );
                      if (cancelou) await recarregar();
                    },
                    child: const Text('Cancelar'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// O que já passou.
///
/// Sem botões, e o cancelado **aparece** em vez de sumir: o tutor lembra de ter marcado
/// aquele dia, e uma lista que nega o que ele lembra faz duvidar da tela inteira. É a
/// mesma decisão do atendimento anulado na linha do tempo do pet.
class _LinhaDoPassado extends StatelessWidget {
  const _LinhaDoPassado({required this.agendamento, required this.tempo});

  final PortalAppointment agendamento;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final cancelado = agendamento.status == 'CANCELLED';
    final faltou = agendamento.status == 'NO_SHOW';

    return Linha(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  // A data curta, e não por extenso: a linha divide a largura com o
                  // valor ou com o selo, e a forma por extenso quebrava em duas linhas
                  // em qualquer celular.
                  '${tempo.diaCurto(agendamento.startsAt)}/'
                  '${tempo.ano(agendamento.startsAt)} · '
                  '${tempo.hora(agendamento.startsAt)}',
                  style: tema.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                    decoration: cancelado ? TextDecoration.lineThrough : null,
                    color: cancelado ? tema.colorScheme.onSurfaceVariant : null,
                  ),
                ),
                const SizedBox(height: 2),
                Text('${agendamento.petName} · ${agendamento.services.join(', ')}',
                    style: tema.textTheme.bodySmall
                        ?.copyWith(color: tema.colorScheme.onSurfaceVariant)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          if (cancelado)
            const Selo(texto: 'Cancelado')
          else if (faltou)
            const Selo(texto: 'Não compareceu', erro: true)
          else
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(reais(agendamento.totalCents),
                  style: tema.textTheme.bodyMedium
                      ?.copyWith(fontWeight: FontWeight.w600)),
            ),
        ],
      ),
    );
  }
}

/// O leva-e-traz deste agendamento (AC-05 de MOD-PORTAL-07).
///
/// **Status e janela, e nada mais.** Sem mapa, sem a posição do veículo e sem o nome do
/// motorista: nada disso muda o que o tutor faz a seguir, e o rastreamento carrega uma
/// discussão de LGPD que não se resolve numa tela. O texto do status vem pronto do
/// servidor — o rótulo do painel é escrito para quem opera, e "Sem motorista" no celular
/// do tutor leria como falha.
///
/// O app não **pede** leva-e-traz, mas mostra o que foi pedido pela web: esconder aqui
/// faria o tutor achar que o transporte se perdeu.
class _FaixaDoTaxi extends StatelessWidget {
  const _FaixaDoTaxi({required this.corridas, required this.tempo});

  final List<PortalTaxiRide> corridas;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    if (corridas.isEmpty) return const SizedBox.shrink();
    final tema = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final corrida in corridas)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.local_shipping_outlined,
                      size: 18, color: tema.colorScheme.onSurfaceVariant),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${corrida.legLabel} · ${corrida.statusText}',
                            style: tema.textTheme.bodySmall),
                        Text(
                          'entre ${tempo.hora(corrida.windowStartsAt)} e '
                          '${tempo.hora(corrida.windowEndsAt)}',
                          style: tema.textTheme.bodySmall
                              ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

String _comMaiuscula(String texto) =>
    texto.isEmpty ? texto : texto[0].toUpperCase() + texto.substring(1);
