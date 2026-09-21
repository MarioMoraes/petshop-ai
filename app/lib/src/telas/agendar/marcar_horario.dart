import 'package:flutter/material.dart';

import '../../api/agendamento_criado.dart';
import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import 'grade_de_horarios.dart';

/// Marcar horário (MOD-PORTAL-05).
///
/// **Uma coluna que cresce, e não um assistente com Avançar e Voltar.** A tela do Admin
/// tem cinco passos porque a recepção agenda dezenas por dia e precisa corrigir o passo
/// 2 sem perder o 4. O tutor faz isto quatro vezes por ano, com o polegar: cada resposta
/// abre a pergunta seguinte logo abaixo, e trocar de ideia é rolar para cima e tocar de
/// novo. A decisão é da web, e num app ela vale ainda mais.
///
/// Cada pergunta depende da anterior **no servidor**, e não só na tela: o preço é do
/// porte do pet, a grade é da duração dos serviços escolhidos, e a antecedência mínima
/// já vem descontada da lista. Nada aqui é calculado no aparelho — o que o tutor vê é o
/// que o POST vai aceitar.
///
/// **O leva-e-traz fica fora desta etapa**, de propósito: é um ramo inteiro (oferta,
/// duas pernas, janela, a recusa por falta de vaga com horários alternativos) e custa
/// quase uma etapa sozinho. Quem quiser o transporte continua pedindo pela web, onde o
/// ramo existe inteiro.
class MarcarHorario extends StatelessWidget {
  const MarcarHorario({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final contexto = sessao.contexto!;

    return Scaffold(
      appBar: AppBar(title: const Text('Marcar horário')),
      body: !contexto.features.onlineBookingEnabled
          // AC-07: a tela não existe com o agendamento online desligado — e quem chegou
          // aqui encontra a explicação, não um 403 cru. Quem garante a regra é o
          // servidor: as três rotas respondem 403 mesmo chamadas direto.
          ? ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Aviso(
                  icone: Icons.event_busy_outlined,
                  texto: 'O ${contexto.tenant.name} não recebe agendamentos por aqui. '
                      'Fale com a equipe para marcar o horário do seu pet.',
                ),
              ],
            )
          : CarregarDados<List<PortalPetSummary>>(
              buscar: () async {
                final pets = await sessao.api.pets();
                // Pet falecido não entra: a ficha dele já é somente leitura, e deixá-lo
                // aqui devolveria pela porta dos fundos o que a ficha negou.
                return pets.where((pet) => !pet.inMemoriam).toList();
              },
              construir: (context, pets, _) => pets.isEmpty
                  ? ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        EstadoVazio(
                          icone: Icons.pets_outlined,
                          titulo: 'Nenhum pet para agendar',
                          descricao:
                              'Fale com o ${contexto.tenant.name} para cadastrar o seu pet.',
                        ),
                      ],
                    )
                  : _Formulario(sessao: sessao, pets: pets),
            ),
    );
  }
}

class _Formulario extends StatefulWidget {
  const _Formulario({required this.sessao, required this.pets});

  final Sessao sessao;
  final List<PortalPetSummary> pets;

  @override
  State<_Formulario> createState() => _FormularioState();
}

class _FormularioState extends State<_Formulario> {
  late String? _petId = widget.pets.length == 1 ? widget.pets.first.id : null;

  List<PortalBookableService> _servicos = [];
  final _escolhidos = <String>{};

  DateTime? _dia;
  List<PortalSlot> _horarios = [];
  String? _proximo;
  int _antecedenciaHoras = 0;
  PortalSlot? _horario;

  late String _fuso = widget.sessao.contexto?.tenant.timezone ?? 'America/Sao_Paulo';
  TenantTime get _tempo => TenantTime(_fuso);

  bool _ocupado = false;
  PortalError? _falha;

  /// RN-09: o alerta clínico é um "tem certeza?", e a segunda tentativa passa. Este
  /// estado é o que muda o texto do botão — confirmar de novo sem avisar que algo mudou
  /// seria pedir a mesma resposta duas vezes.
  bool _reconhecerAlertas = false;

  /// O desfecho. Com ele preenchido a tela deixa de ser um formulário e passa a ser um
  /// comprovante: o tutor precisa ver o que ficou marcado, e não voltar a uma lista de
  /// perguntas já respondidas.
  AgendamentoCriado? _marcado;

  /// Cada busca leva a sua marca, e só a última vale.
  ///
  /// Trocar de dia duas vezes num 4G ruim deixa duas buscas no ar, e sem isto a que
  /// chegasse por último venceria — ainda que fosse a resposta do dia anterior. É o
  /// mesmo horário fantasma que o assistente do Admin já teve.
  int _busca = 0;

  @override
  void initState() {
    super.initState();
    if (_petId != null) _carregarServicos();
  }

  PortalPetSummary? get _pet =>
      widget.pets.where((pet) => pet.id == _petId).firstOrNull;

  List<PortalBookableService> get _selecionados =>
      _servicos.where((s) => _escolhidos.contains(s.id)).toList();

  int get _totalCents =>
      _selecionados.fold(0, (soma, servico) => soma + servico.priceCents);

  // ── As perguntas, uma de cada vez ──────────────────────────────────────────

  Future<void> _escolherPet(String id) async {
    setState(() {
      _petId = id;
      _servicos = [];
      _escolhidos.clear();
      _horarios = [];
      _horario = null;
      _falha = null;
    });
    await _carregarServicos();
  }

  /// Os serviços dependem do pet: o preço é do porte dele, e o serviço sem preço para
  /// aquele porte **não aparece** — oferecê-lo para recusar na confirmação seria levar
  /// alguém até o fim de um caminho sem saída.
  Future<void> _carregarServicos() async {
    final id = _petId;
    if (id == null) return;

    setState(() {
      _ocupado = true;
      _falha = null;
    });
    try {
      final resposta = await widget.sessao.api.servicos(id);
      if (mounted) setState(() => _servicos = resposta.services);
    } on PortalError catch (e) {
      if (mounted) setState(() => _falha = e);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  void _alternarServico(String id) {
    setState(() {
      if (!_escolhidos.remove(id)) _escolhidos.add(id);
      _horario = null;
      _falha = null;
    });
    // A grade depende do **conjunto**: trocar um serviço muda a duração, e a duração
    // muda quais vagas cabem.
    if (_dia != null) _carregarHorarios();
  }

  Future<void> _escolherDia() async {
    final hoje = _tempo.hoje;
    final escolhido = await showDatePicker(
      context: context,
      initialDate: _dia ?? hoje,
      // Hoje no fuso do **petshop**, que pode não ser o hoje do aparelho.
      firstDate: hoje,
      // Um ano é folga, não regra: quem decide até quando a agenda abre é o servidor,
      // e o dia sem vaga responde com a lista vazia e o próximo disponível.
      lastDate: DateTime(hoje.year + 1, hoje.month, hoje.day),
    );
    if (escolhido == null) return;

    setState(() {
      _dia = escolhido;
      _horario = null;
      _falha = null;
    });
    await _carregarHorarios();
  }

  Future<void> _carregarHorarios() async {
    final id = _petId;
    final dia = _dia;
    if (id == null || dia == null || _escolhidos.isEmpty) return;

    final marca = ++_busca;
    setState(() {
      _ocupado = true;
      _falha = null;
    });

    try {
      final grade = await buscarGrade(
        widget.sessao.api,
        petId: id,
        serviceIds: _escolhidos.toList(),
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
    final id = _petId;
    final horario = _horario;
    if (id == null || horario == null) return;

    setState(() {
      _ocupado = true;
      _falha = null;
    });

    try {
      final marcado = await widget.sessao.api.agendar(PortalBooking(
        petId: id,
        serviceIds: _escolhidos.toList(),
        // O instante sai **como o servidor o mandou**: `DateTime.parse` de um texto com
        // `Z` devolve um instante em UTC, e `toIso8601String` o devolve com o `Z`. Um
        // `toLocal()` no meio do caminho mandaria a hora do aparelho com cara de UTC.
        startsAt: DateTime.parse(horario.startsAt),
        // O horário que o tutor tocou já nomeia quem atende: cada vaga da grade é de um
        // profissional, e deixar o servidor escolher é como se marca o banho na pessoa
        // errada.
        professionalId: horario.professionalId,
        acknowledgedAlerts: _reconhecerAlertas,
        notes: null,
        taxi: null,
      ));
      if (mounted) setState(() => _marcado = marcado);
    } on PortalError catch (e) {
      if (!mounted) return;
      setState(() {
        _falha = e;
        // RN-09: o próximo toque no mesmo botão é o "sim, eu vi".
        if (e.code == 'ERR_AGENDA_009') _reconhecerAlertas = true;
      });
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  // ── A tela ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final marcado = _marcado;
    if (marcado != null) {
      return _Comprovante(agendamento: marcado, tempo: _tempo);
    }

    final pet = _pet;
    final contexto = widget.sessao.contexto!;

    /// A numeração é montada, e não escrita à mão: o cartão do pet só existe para quem
    /// tem mais de um, e sem isto a tela diria "Passo 2" duas vezes na mesma rolagem.
    final passos = [
      if (widget.pets.length > 1) 'pet',
      'servicos',
      'dia',
    ];
    String passo(String chave) => 'PASSO ${passos.indexOf(chave) + 1}';

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        if (contexto.features.onlineBookingRequiresApproval) ...[
          const Aviso(
            icone: Icons.schedule_outlined,
            texto: 'O horário fica reservado e o estabelecimento confirma em seguida.',
          ),
          const SizedBox(height: 16),
        ],

        if (widget.pets.length > 1) ...[
          CartaoDeSecao(
            cabecalho: CabecalhoDeSecao(
              icone: Icons.pets_outlined,
              titulo: 'Para quem é',
              descricao: passo('pet'),
            ),
            filhos: [
              for (final candidato in widget.pets) ...[
                Escolha(
                  marcada: candidato.id == _petId,
                  aoMudar: (_) => _escolherPet(candidato.id),
                  titulo: candidato.name,
                  descricao: [candidato.species, candidato.breed]
                      .where((p) => p != null && p.isNotEmpty)
                      .join(' · '),
                ),
                const SizedBox(height: 8),
              ],
            ],
          ),
          const SizedBox(height: 16),
        ],

        if (pet != null) ...[
          CartaoDeSecao(
            cabecalho: CabecalhoDeSecao(
              icone: Icons.content_cut_outlined,
              titulo: 'O que o pet vai fazer',
              descricao: '${passo('servicos')} · os preços são os do porte do ${pet.name}',
            ),
            filhos: [
              if (_servicos.isEmpty && !_ocupado)
                Text(
                  'O ${contexto.tenant.name} ainda não tem serviços disponíveis para '
                  'agendar pelo app.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                ),
              for (final servico in _servicos) ...[
                Escolha(
                  marcada: _escolhidos.contains(servico.id),
                  aoMudar: (_) => _alternarServico(servico.id),
                  titulo: servico.name,
                  descricao: servico.description,
                  aDireita: reais(servico.priceCents),
                ),
                const SizedBox(height: 8),
              ],
              if (_selecionados.length > 1)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('Total: ${reais(_totalCents)}',
                      style: Theme.of(context).textTheme.bodyMedium),
                ),
            ],
          ),
          const SizedBox(height: 16),
        ],

        if (_escolhidos.isNotEmpty) ...[
          CartaoDeSecao(
            cabecalho: CabecalhoDeSecao(
              icone: Icons.calendar_today_outlined,
              titulo: 'Que dia',
              descricao: passo('dia'),
            ),
            filhos: [
              OutlinedButton.icon(
                onPressed: _escolherDia,
                icon: const Icon(Icons.calendar_month_outlined, size: 18),
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
          const SizedBox(height: 16),
        ],

        if (_falha != null) ...[
          RecusaComAlternativas(
            falha: _falha!,
            tempo: _tempo,
            horarios: _horarios,
            aoEscolher: (slot) => setState(() {
              _horario = slot;
              _falha = null;
            }),
          ),
          const SizedBox(height: 16),
        ],

        if (_horario != null && pet != null)
          CartaoDeSecao(
            cabecalho: const CabecalhoDeSecao(
              icone: Icons.check_circle_outline,
              titulo: 'Tudo certo?',
            ),
            filhos: [
              Text('${pet.name} · ${_selecionados.map((s) => s.name).join(', ')}',
                  style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 4),
              Text(
                '${_tempo.diaPorExtenso(_horario!.startsAt)} às '
                '${_tempo.hora(_horario!.startsAt)} com ${_horario!.professionalName}',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
              const SizedBox(height: 10),
              Text(reais(_totalCents),
                  style: Theme.of(context)
                      .textTheme
                      .titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 16),
              BotaoPrincipal(
                rotulo: _reconhecerAlertas ? 'Confirmar mesmo assim' : 'Confirmar horário',
                rotuloOcupado: 'Marcando…',
                ocupado: _ocupado,
                onPressed: _confirmar,
              ),
            ],
          ),
      ],
    );
  }

  /// O dia escolhido vira um instante só para ser escrito por extenso. Meio-dia, e não
  /// meia-noite: é a hora que não muda de dia em nenhum fuso do Brasil.
  String _diaComoInstante(DateTime dia) =>
      DateTime.utc(dia.year, dia.month, dia.day, 12).toIso8601String();

  bool _ehHoje(DateTime dia) {
    final hoje = _tempo.hoje;
    return dia.year == hoje.year && dia.month == hoje.month && dia.day == hoje.day;
  }
}

/// O comprovante.
///
/// A tela para aqui em vez de voltar sozinha para o Início: o tutor acabou de gastar
/// cinco toques e precisa ver o que ficou marcado, com a hora **do petshop**. Quando a
/// etapa 4 existir, daqui sai o caminho para "Meus agendamentos".
class _Comprovante extends StatelessWidget {
  const _Comprovante({required this.agendamento, required this.tempo});

  final AgendamentoCriado agendamento;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 32, 16, 32),
      children: [
        Icon(Icons.check_circle_outline, size: 56, color: tema.colorScheme.primary),
        const SizedBox(height: 16),
        Text(
          agendamento.awaitingApproval ? 'Horário reservado' : 'Horário marcado',
          textAlign: TextAlign.center,
          style: tema.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        Text(
          agendamento.awaitingApproval
              ? 'O estabelecimento confirma em seguida. Você recebe um aviso quando '
                  'isso acontecer.'
              : 'Está tudo certo. Até lá!',
          textAlign: TextAlign.center,
          style: tema.textTheme.bodyMedium
              ?.copyWith(color: tema.colorScheme.onSurfaceVariant, height: 1.45),
        ),
        const SizedBox(height: 24),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                LinhaDeDado(rotulo: 'Pet', valor: agendamento.petName),
                LinhaDeDado(
                    rotulo: 'Serviços', valor: agendamento.services.join(', ')),
                LinhaDeDado(
                  rotulo: 'Quando',
                  valor: '${tempo.diaPorExtenso(agendamento.startsAt)} às '
                      '${tempo.hora(agendamento.startsAt)}',
                ),
                LinhaDeDado(
                    rotulo: 'Com', valor: agendamento.professionalName),
                LinhaDeDado(
                    rotulo: 'Total', valor: reais(agendamento.totalCents)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 24),
        BotaoPrincipal(
          rotulo: 'Voltar ao início',
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    );
  }
}
