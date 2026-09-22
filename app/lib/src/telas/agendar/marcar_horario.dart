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
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import 'grade_de_horarios.dart';
import 'leva_e_traz.dart';

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
/// **O leva-e-traz entra aqui, e não numa tela própria** (MOD-PORTAL-07): no MOD-TAXI o
/// dono da corrida é o agendamento, e pedir transporte solto criaria uma segunda fila de
/// aprovação para a mesma tarde. O ramo inteiro vive em `leva_e_traz.dart`; esta tela
/// guarda só a escolha, o total e as duas recusas que ele pode provocar.
class MarcarHorario extends StatelessWidget {
  const MarcarHorario({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final contexto = sessao.contexto!;

    return Tela(
      appBar: AppBar(title: const Text('Marcar horário')),
      corpo: !contexto.features.onlineBookingEnabled
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

  /// A oferta de leva-e-traz, pedida uma vez (MOD-PORTAL-07).
  ///
  /// Nula enquanto não chegou **e** quando a pergunta falhou: o transporte é um extra, e
  /// derrubar o agendamento inteiro porque a van não respondeu seria trocar o essencial
  /// pelo acessório. Quem não tem oferta simplesmente não vê o cartão.
  PortalTaxiOffer? _oferta;
  bool _levar = false;
  bool _trazer = false;

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
    if (widget.sessao.contexto!.features.taxiEnabled) _carregarOferta();
  }

  /// A oferta é pedida **uma vez**, e não a cada escolha.
  ///
  /// O preço é do CEP do endereço primário do tutor: nem o pet, nem os serviços, nem o
  /// horário o mudam. Refazer a pergunta a cada toque só somaria espera à tela.
  ///
  /// E não é pedida de jeito nenhum com o módulo desligado no plano: `taxiEnabled` do
  /// contexto é o que evita uma chamada que responderia 402 — a navegação lê `features`,
  /// nunca uma constante.
  Future<void> _carregarOferta() async {
    try {
      final oferta = await widget.sessao.api.ofertaDeTaxi();
      if (mounted) setState(() => _oferta = oferta);
    } on PortalError {
      // Silêncio de propósito: sem oferta o cartão não aparece, e o agendamento segue.
      // O transporte é um extra — derrubar o horário porque a van não respondeu seria
      // trocar o essencial pelo acessório.
    }
  }

  PortalPetSummary? get _pet =>
      widget.pets.where((pet) => pet.id == _petId).firstOrNull;

  List<PortalBookableService> get _selecionados =>
      _servicos.where((s) => _escolhidos.contains(s.id)).toList();

  int get _servicosCents =>
      _selecionados.fold(0, (soma, servico) => soma + servico.priceCents);

  /// O cartão do leva-e-traz existe nesta tela?
  bool get _temTaxi =>
      widget.sessao.contexto!.features.taxiEnabled && ofereceLevaETraz(_oferta);

  int get _pernas => (_levar ? 1 : 0) + (_trazer ? 1 : 0);

  int get _taxiCents => (_oferta?.priceCentsPerLeg ?? 0) * _pernas;

  /// AC-02: o valor da corrida somado ao do serviço, **antes** da confirmação — e
  /// discriminado, nunca embutido, porque o tutor precisa poder decidir tirar só o
  /// transporte.
  int get _totalCents => _servicosCents + _taxiCents;

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

  /// Confirma o pedido.
  ///
  /// `comTaxi` existe para o "marcar sem o leva-e-traz" da recusa por falta de vaga
  /// (AC-04): reenvia o mesmo pedido sem o transporte, sem obrigar o tutor a rolar para
  /// cima e desmarcar duas caixas. Perder o banho por causa da van é o pior desfecho
  /// possível, e um toque é o que separa o tutor dele.
  Future<void> _confirmar({bool comTaxi = true}) async {
    final id = _petId;
    final horario = _horario;
    if (id == null || horario == null) return;

    final pedirTaxi = comTaxi && _temTaxi && _pernas > 0;

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
        // Ida e volta são duas linhas em `taxi_rides`, e por isso duas caixas
        // independentes. Sem perna escolhida o campo não vai: `semNulos` o corta, e o
        // schema é `.strict()` com um `refine` que recusa as duas falsas.
        taxi: pedirTaxi
            ? PortalBookingTaxi(pickup: _levar, dropoff: _trazer)
            : null,
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
    /// tem mais de um, o do leva-e-traz só para quem pode pedir, e sem isto a tela diria
    /// "Passo 2" duas vezes na mesma rolagem.
    final passos = [
      if (widget.pets.length > 1) 'pet',
      'servicos',
      if (_temTaxi) 'taxi',
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
              icone: Icons.pets_rounded,
              base: Tons.tempo,
              titulo: 'Para quem é',
              etiqueta: passo('pet'),
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
              icone: Icons.content_cut_rounded,
              base: Tons.tempo,
              titulo: 'O que o pet vai fazer',
              etiqueta: passo('servicos'),
              descricao: 'Os preços são os do porte do ${pet.name}',
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
                  padding: const EdgeInsets.only(top: 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text('Total: ${reais(_servicosCents)}',
                          style: Theme.of(context).textTheme.titleSmall),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
        ],

        // O transporte vem **antes** do dia, e não depois do horário: a oferta não
        // depende de nenhum dos dois, e perguntá-la no fim faria o tutor rever a
        // confirmação inteira só para marcar uma caixa.
        if (_escolhidos.isNotEmpty && _temTaxi) ...[
          CartaoDoLevaETraz(
            oferta: _oferta!,
            levar: _levar,
            trazer: _trazer,
            etiqueta: passo('taxi'),
            aoMudarLevar: (valor) => setState(() {
              _levar = valor;
              _falha = null;
            }),
            aoMudarTrazer: (valor) => setState(() {
              _trazer = valor;
              _falha = null;
            }),
          ),
          const SizedBox(height: 16),
        ],

        if (_escolhidos.isNotEmpty) ...[
          CartaoDeSecao(
            cabecalho: CabecalhoDeSecao(
              icone: Icons.calendar_month_rounded,
              base: Tons.tempo,
              titulo: 'Que dia',
              etiqueta: passo('dia'),
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
          const SizedBox(height: 16),
        ],

        if (_falha != null) ...[
          RecusaComAlternativas(
            falha: _falha!,
            tempo: _tempo,
            horarios: _horarios,
            // AC-04: a van lotada tem título próprio. "Não deu para marcar" faria o
            // tutor procurar o defeito no horário, que está livre.
            tituloPadrao: _falha!.code == 'ERR_TAXI_007'
                ? 'Sem vaga no leva-e-traz'
                : 'Não deu para marcar',
            aoEscolher: (slot) => setState(() {
              _horario = slot;
              _falha = null;
            }),
            rodape: _falha!.code == 'ERR_TAXI_007'
                ? OutlinedButton(
                    onPressed: _ocupado ? null : () => _confirmar(comTaxi: false),
                    child: const Text('Marcar sem o leva-e-traz'),
                  )
                : null,
          ),
          const SizedBox(height: 16),
        ],

        if (_horario != null && pet != null)
          CartaoDeSecao(
            // O último cartão é o que o olho precisa achar depois de rolar três
            // perguntas: é ele que tem o botão que grava.
            realce: true,
            cabecalho: const CabecalhoDeSecao(
              icone: Icons.check_circle_outline,
              base: Tons.tempo,
              titulo: 'Tudo certo?',
            ),
            filhos: [
              Text('${pet.name} · ${_selecionados.map((s) => s.name).join(', ')}',
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: context.tokens.tinta,
                      )),
              const SizedBox(height: 4),
              Text(
                '${_tempo.diaPorExtenso(_horario!.startsAt)} às '
                '${_tempo.hora(_horario!.startsAt)} com ${_horario!.professionalName}',
                style: Theme.of(context).textTheme.bodySmall,
              ),

              // AC-02: o transporte aparece discriminado, e não somado em silêncio ao
              // serviço — é ele que o tutor pode tirar se o total surpreender.
              if (_pernas > 0) ...[
                const SizedBox(height: 4),
                Text(
                  'Leva-e-traz: '
                  '${[if (_levar) 'buscar', if (_trazer) 'devolver'].join(' e ')}'
                  ' · ${reais(_taxiCents)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],

              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: context.tokens.chip,
                  borderRadius: BorderRadius.circular(Raio.controle),
                ),
                child: Row(
                  children: [
                    Text('Total',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: context.tokens.discreta,
                            )),
                    const Spacer(),
                    Text(reais(_totalCents),
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              fontSize: 18,
                              letterSpacing: -0.4,
                            )),
                  ],
                ),
              ),
              const SizedBox(height: 18),
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
/// cinco toques e precisa ver o que ficou marcado, com a hora **do petshop**.
///
/// **É aqui que o `taxiWarning` é lido** (AC-03), e não numa faixa no formulário como na
/// web: lá a confirmação navegava para a lista, e o aviso precisava de um estado próprio
/// para segurar o tutor na tela. Aqui o desfecho já é uma tela que para — o agendamento
/// nasceu, o transporte não, e as duas notícias chegam juntas, que é a ordem em que elas
/// aconteceram. Passar batido daria ao tutor a certeza de que alguém vai buscar o pet.
class _Comprovante extends StatelessWidget {
  const _Comprovante({required this.agendamento, required this.tempo});

  final AgendamentoCriado agendamento;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 36),
      children: [
        // O desfecho é a única outra tela com o painel escuro, e é de propósito: o
        // tutor gastou cinco toques, e o que ele precisa ver agora não é mais um
        // cartão branco igual aos três que respondeu.
        PainelEscuro(
          padding: const EdgeInsets.fromLTRB(24, 28, 24, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 52,
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
                ),
                child: const Icon(Icons.check_rounded, size: 27, color: Colors.white),
              ),
              const SizedBox(height: 18),
              Text(
                agendamento.awaitingApproval ? 'Horário reservado' : 'Horário marcado',
                style: tema.textTheme.headlineMedium?.copyWith(color: Colors.white),
              ),
              const SizedBox(height: 8),
              Text(
                agendamento.awaitingApproval
                    ? 'O estabelecimento confirma em seguida. Você recebe um aviso '
                        'quando isso acontecer.'
                    : 'Está tudo certo. Até lá!',
                style: tema.textTheme.bodySmall?.copyWith(
                  color: Colors.white.withValues(alpha: 0.76),
                  height: 1.55,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        Cartao(
          padding: const EdgeInsets.all(18),
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
              LinhaDeDado(rotulo: 'Com', valor: agendamento.professionalName),

              // As corridas que nasceram junto: duas linhas em `taxi_rides` viram duas
              // linhas aqui, cada uma com a sua janela.
              if (agendamento.taxi.isNotEmpty) ...[
                const SizedBox(height: 12),
                CorridasDoAgendamento(
                    corridas: agendamento.taxi, tempo: tempo),
              ],

              const SizedBox(height: 6),
              Divider(color: t.linha),
              const SizedBox(height: 10),
              Row(
                children: [
                  // `Expanded` e não `Spacer` porque o rótulo cresce quando há
                  // transporte: quem cede espaço é a palavra, nunca o valor. Com a
                  // fonte grande da acessibilidade os dois disputavam a mesma linha e
                  // um deles sumia.
                  Expanded(
                    child: Text(
                        agendamento.taxi.isEmpty
                            ? 'Total'
                            : 'Total com o transporte',
                        overflow: TextOverflow.ellipsis,
                        style: tema.textTheme.bodySmall
                            ?.copyWith(color: t.discreta)),
                  ),
                  const SizedBox(width: 12),
                  // `totalCents` é o do **atendimento**: a corrida é outra linha, com
                  // preço próprio, e o servidor não as soma. Somar aqui é o que faz o
                  // comprovante dizer o mesmo número que a confirmação dizia.
                  Text(reais(_totalComTransporte(agendamento)),
                      style: tema.textTheme.titleMedium
                          ?.copyWith(fontSize: 18, letterSpacing: -0.4)),
                ],
              ),
            ],
          ),
        ),

        // AC-03: o horário existe e o transporte não. É a única notícia que o tutor vai
        // receber sobre a corrida que ele pediu.
        if (agendamento.taxiWarning != null) ...[
          const SizedBox(height: 16),
          Aviso(
            tom: TomDoAviso.atencao,
            icone: Icons.local_shipping_rounded,
            titulo: 'Horário marcado, transporte não',
            texto: agendamento.taxiWarning!,
          ),
        ],

        const SizedBox(height: 24),
        BotaoPrincipal(
          rotulo: 'Voltar ao início',
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    );
  }

  int _totalComTransporte(AgendamentoCriado agendamento) =>
      agendamento.totalCents +
      agendamento.taxi.fold(0, (soma, corrida) => soma + corrida.priceCents);
}
