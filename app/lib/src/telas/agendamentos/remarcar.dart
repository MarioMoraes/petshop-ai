import 'package:flutter/material.dart';

import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import '../agendar/grade_de_horarios.dart';

/// Remarcar (AC-04 de MOD-PORTAL-06).
///
/// **Reusa a grade do agendamento, e não uma cópia dela**: é a mesma pergunta com os
/// mesmos serviços — o que muda é o destino da confirmação. Duas versões divergiriam no
/// dia em que a antecedência mínima passasse a filtrar diferente, e esta tela ofereceria
/// um horário que o POST recusa.
///
/// A ficha vem do servidor em vez de viajar da lista, e por um motivo: `serviceIds` só
/// existe no **detalhe**, e é ele que a grade precisa — reconstruir o conjunto a partir
/// dos rótulos exigiria casar texto com catálogo.
class Remarcar extends StatelessWidget {
  const Remarcar({super.key, required this.sessao, required this.agendamentoId});

  final Sessao sessao;
  final String agendamentoId;

  @override
  Widget build(BuildContext context) {
    return Tela(
      appBar: AppBar(title: const Text('Remarcar')),
      corpo: CarregarDados<PortalAppointmentDetail>(
        buscar: () => sessao.api.agendamento(agendamentoId),
        construir: (context, agendamento, _) =>
            _Formulario(sessao: sessao, agendamento: agendamento),
      ),
    );
  }
}

class _Formulario extends StatefulWidget {
  const _Formulario({required this.sessao, required this.agendamento});

  final Sessao sessao;
  final PortalAppointmentDetail agendamento;

  @override
  State<_Formulario> createState() => _FormularioState();
}

class _FormularioState extends State<_Formulario> {
  DateTime? _dia;
  List<PortalSlot> _horarios = [];
  String? _proximo;
  int _antecedenciaHoras = 0;
  PortalSlot? _horario;

  /// O fuso do petshop vem do contexto e **não** de um padrão da tela.
  ///
  /// O cartão do topo mostra o horário atual antes de existir grade nenhuma. Enquanto o
  /// fuso nascia cravado em São Paulo, esse horário aparecia errado para o tenant de
  /// outro fuso e se corrigia sozinho quando a primeira busca respondia — o pior dos
  /// dois mundos, porque quem leu primeiro não viu a correção.
  late String _fuso = widget.sessao.contexto?.tenant.timezone ?? 'America/Sao_Paulo';
  TenantTime get _tempo => TenantTime(_fuso);

  bool _ocupado = false;
  PortalError? _falha;

  /// Mesma guarda do assistente de agendamento: só a última busca vale.
  int _busca = 0;

  Future<void> _escolherDia() async {
    final hoje = _tempo.hoje;
    final escolhido = await showDatePicker(
      context: context,
      initialDate: _dia ?? hoje,
      firstDate: hoje,
      lastDate: DateTime(hoje.year + 1, hoje.month, hoje.day),
    );
    if (escolhido == null) return;

    setState(() {
      _dia = escolhido;
      _horario = null;
      _falha = null;
      // A grade do dia anterior sai da tela antes de a nova chegar: mantê-la visível
      // ofereceria horários de outro dia para tocar, e o cartão de confirmação diria um
      // dia que o tutor não escolheu.
      _horarios = [];
      _proximo = null;
    });
    await _carregarHorarios();
  }

  Future<void> _carregarHorarios() async {
    final dia = _dia;
    if (dia == null) return;

    final marca = ++_busca;
    setState(() {
      _ocupado = true;
      _falha = null;
    });

    try {
      final grade = await buscarGrade(
        widget.sessao.api,
        petId: widget.agendamento.petId,
        serviceIds: widget.agendamento.serviceIds,
        dia: dia,
        tempo: _tempo,
      );
      if (!mounted || marca != _busca) return;
      setState(() {
        _horarios = grade.slots;
        _proximo = grade.proximo;
        _antecedenciaHoras = grade.antecedenciaHoras;
        _fuso = grade.fuso;
      });
    } on PortalError catch (e) {
      if (!mounted || marca != _busca) return;
      setState(() {
        _falha = e;
        _horarios = [];
      });
    } finally {
      if (mounted && marca == _busca) setState(() => _ocupado = false);
    }
  }

  Future<void> _confirmar() async {
    final horario = _horario;
    if (horario == null) return;

    setState(() {
      _ocupado = true;
      _falha = null;
    });

    try {
      await widget.sessao.api.remarcar(
        widget.agendamento.id,
        PortalReschedule(
          startsAt: DateTime.parse(horario.startsAt),
          professionalId: horario.professionalId,
        ),
      );
      // O agendamento novo é outro registro, e é a lista que mostra os dois estados.
      if (mounted) Navigator.of(context).pop(true);
    } on PortalError catch (e) {
      if (mounted) setState(() => _falha = e);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final agendamento = widget.agendamento;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        // O horário atual fica visível o tempo todo, no topo. Sem ele, quem abre a tela
        // para "adiantar meia hora" perde a referência do que está mudando.
        CartaoDeSecao(
          cabecalho: CabecalhoDeSecao(
            icone: Icons.event_available_rounded,
            base: Tons.tempo,
            titulo: 'Hoje está marcado',
            descricao: '${_tempo.diaPorExtenso(agendamento.startsAt)} às '
                '${_tempo.hora(agendamento.startsAt)}',
          ),
          filhos: [
            Text(
              '${agendamento.petName} · ${agendamento.services.join(', ')}\n'
              'com ${agendamento.professionalName} · ${reais(agendamento.totalCents)}',
              style: tema.textTheme.bodySmall?.copyWith(height: 1.55),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // RN-15 do MOD-TAXI: remarcar **não** move a corrida. O agendamento novo é outro
        // registro, e mover a janela sozinho assumiria que o motorista está livre no dia
        // novo — o que ninguém verificou. O tutor precisa saber disso **antes** de
        // confirmar: descobrir na porta de casa que ninguém vem buscar é o pior jeito de
        // aprender a regra.
        if (agendamento.taxi.isNotEmpty) ...[
          const Aviso(
            icone: Icons.local_shipping_outlined,
            titulo: 'O leva-e-traz não vai junto',
            texto: 'Ao remarcar, o transporte deste horário é cancelado. Fale com o '
                'estabelecimento para pedir de novo.',
          ),
          const SizedBox(height: 16),
        ],

        CartaoDeSecao(
          cabecalho: const CabecalhoDeSecao(
            icone: Icons.calendar_month_rounded,
            base: Tons.tempo,
            titulo: 'Novo horário',
          ),
          filhos: [
            OutlinedButton.icon(
              onPressed: _escolherDia,
              icon: const Icon(Icons.calendar_today_rounded, size: 17),
              label: Text(_dia == null
                  ? 'Escolher o dia'
                  : _tempo.diaPorExtenso(_diaComoInstante(_dia!))),
            ),
            if (_dia != null) ...[
              const SizedBox(height: 14),
              GradeDeHorarios(
                horarios: _horarios,
                escolhido: _horario,
                tempo: _tempo,
                carregando: _ocupado,
                proximo: _proximo,
                antecedenciaHoras: _antecedenciaHoras,
                ehHoje: _ehHoje(_dia!),
                aoEscolher: (slot) => setState(() {
                  _horario = slot;
                  _falha = null;
                }),
              ),
            ],
          ],
        ),

        if (_falha != null) ...[
          const SizedBox(height: 16),
          RecusaComAlternativas(
            falha: _falha!,
            tempo: _tempo,
            horarios: _horarios,
            tituloPadrao: 'Não deu para remarcar',
            aoEscolher: (slot) => setState(() {
              _horario = slot;
              _falha = null;
            }),
          ),
        ],

        if (_horario != null) ...[
          const SizedBox(height: 16),
          CartaoDeSecao(
            realce: true,
            cabecalho: const CabecalhoDeSecao(
              icone: Icons.check_circle_outline,
              base: Tons.tempo,
              titulo: 'Tudo certo?',
            ),
            filhos: [
              Text(
                'O horário passa para '
                '${_tempo.diaPorExtenso(_horario!.startsAt)} às '
                '${_tempo.hora(_horario!.startsAt)}, com '
                '${_horario!.professionalName}. O preço é recalculado para a nova data.',
                style: tema.textTheme.bodyMedium?.copyWith(height: 1.45),
              ),
              const SizedBox(height: 16),
              BotaoPrincipal(
                rotulo: 'Confirmar novo horário',
                rotuloOcupado: 'Remarcando…',
                ocupado: _ocupado,
                onPressed: _confirmar,
              ),
            ],
          ),
        ],
      ],
    );
  }

  String _diaComoInstante(DateTime dia) =>
      DateTime.utc(dia.year, dia.month, dia.day, 12).toIso8601String();

  bool _ehHoje(DateTime dia) {
    final hoje = _tempo.hoje;
    return dia.year == hoje.year && dia.month == hoje.month && dia.day == hoje.day;
  }
}
