import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'auth/sessao.dart';
import 'notificacoes.dart';
import 'telas/agendamentos/lista_de_agendamentos.dart';
import 'telas/entrar.dart';
import 'telas/escolher_petshop.dart';
import 'telas/financeiro/minha_conta.dart';
import 'telas/inicio.dart';
import 'telas/vincular.dart';
import 'ui/abertura.dart';
import 'ui/superficies.dart';
import 'ui/tema.dart';

/// A raiz do app.
///
/// Não há roteador de rotas nomeadas aqui, e isso é deliberado: **as telas de entrada
/// não são lugares aonde se navega, são estados em que se está.** Quem não escolheu
/// petshop não pode "voltar" para os pets; quem não vinculou a ficha não tem para onde
/// ir. Um `Navigator` com pilha daria a impressão contrária e abriria caminhos que o
/// backend responderia com 401.
///
/// Quem manda é `Sessao.estado`, e ele muda por `revalidar()`, que pergunta ao servidor
/// em vez de deduzir.
class App extends StatefulWidget {
  const App({super.key, this.sessao});

  /// A sessão já montada, quando quem chama tem uma — é assim que o teste de widget
  /// percorre o app inteiro contra respostas conhecidas.
  final Sessao? sessao;

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> {
  late final _sessao = widget.sessao ?? Sessao();

  /// As duas chaves existem pelo push: o aviso chega por fora da árvore de widgets, e é
  /// por elas que ele alcança a pilha de telas e a barra de recado.
  final _navegador = GlobalKey<NavigatorState>();
  final _mensageiro = GlobalKey<ScaffoldMessengerState>();

  /// O aviso tocado antes de a sessão ficar pronta — o caso comum: o toque abre o app
  /// frio, e a tela certa só existe depois de a Clerk e o `/me` responderem.
  AvisoTocado? _pendente;
  StreamSubscription<AvisoTocado>? _tocados;
  StreamSubscription<AvisoTocado>? _primeiroPlano;

  @override
  void initState() {
    super.initState();
    _sessao.addListener(_abrirPendente);
    _sessao.iniciar();
    _escutarAvisos();
  }

  @override
  void dispose() {
    _tocados?.cancel();
    _primeiroPlano?.cancel();
    _sessao.removeListener(_abrirPendente);
    _sessao.dispose();
    super.dispose();
  }

  Future<void> _escutarAvisos() async {
    if (!await avisos.iniciar()) return;
    _tocados = avisos.tocados.listen(_abrir);
    _primeiroPlano = avisos.emPrimeiroPlano.listen(_mostrar);
    final inicial = await avisos.inicial();
    if (inicial != null) _abrir(inicial);
  }

  void _abrir(AvisoTocado aviso) {
    _pendente = aviso;
    _abrirPendente();
  }

  /// Leva à tela do aviso, quando há sessão para isso.
  ///
  /// **O aviso de outro petshop não navega.** O celular pode ter estado em duas contas, e
  /// o toque no lembrete do petshop A com a sessão no B abriria a agenda errada, dizendo
  /// "nenhum horário" sobre um horário que existe. Nesse caso o toque só abre o app.
  void _abrirPendente() {
    final aviso = _pendente;
    if (aviso == null || _sessao.estado != EstadoDaSessao.pronta) return;
    _pendente = null;
    if (aviso.slug != null && aviso.slug != _sessao.slug) return;

    // Depois do quadro: este método também roda dentro do `notifyListeners` da sessão,
    // e empilhar rota no meio de uma reconstrução é o que o `Navigator` recusa.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final pilha = _navegador.currentState;
      if (pilha == null) return;
      pilha.popUntil((rota) => rota.isFirst);
      pilha.push(MaterialPageRoute(
        builder: (_) => aviso.abre == 'conta'
            ? MinhaConta(sessao: _sessao)
            : ListaDeAgendamentos(sessao: _sessao),
      ));
    });
    // E o quadro precisa existir: o aviso chega por fora da árvore, com o app parado, e
    // sem nada pedindo redesenho o callback acima esperaria o próximo toque na tela.
    WidgetsBinding.instance.scheduleFrame();
  }

  /// O aviso com o app aberto. O Android não o desenha em primeiro plano, e sem isto ele
  /// simplesmente não apareceria para quem está olhando para o app.
  void _mostrar(AvisoTocado aviso) {
    if (aviso.slug != null && aviso.slug != _sessao.slug) return;
    _mensageiro.currentState?.showSnackBar(
      SnackBar(
        content: Text(aviso.titulo ?? 'Novo aviso do ${_sessao.tenant?.name ?? 'petshop'}'),
        action: SnackBarAction(label: 'Ver', onPressed: () => _abrir(aviso)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _sessao,
      builder: (context, _) {
        final brilho = MediaQuery.platformBrightnessOf(context);
        return MaterialApp(
          navigatorKey: _navegador,
          scaffoldMessengerKey: _mensageiro,
          title: 'Meu PetShop AI',
          debugShowCheckedModeBanner: false,
          theme: temaDoPetshop(_sessao.tenant?.brandColor, brilho),
          // O app é de um público só, e ele fala português. Sem os delegates, o seletor
          // de data do Material abre em inglês — e `TenantTime` já carrega o `pt_BR` do
          // `intl` por outro caminho, então as duas metades da tela diriam idiomas
          // diferentes na mesma linha.
          locale: const Locale('pt', 'BR'),
          supportedLocales: const [Locale('pt', 'BR')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          // A abertura cobre a resolução da sessão — e a tela de verdade é montada por
          // baixo dela desde o primeiro quadro, então quando a cortina sai não há rota
          // a empilhar nem primeiro quadro a construir.
          home: Abertura(
            pronto: _sessao.estado != EstadoDaSessao.carregando,
            child: _tela(),
          ),
        );
      },
    );
  }

  Widget _tela() => switch (_sessao.estado) {
        // Sob a abertura, e quase sempre invisível: o que se vê enquanto a sessão não
        // respondeu é a cortina. Este ramo é o fundo que ela cobre — sem disco girando,
        // que apareceria por um quadro no esmaecer se a resposta demorasse mais que a
        // animação.
        EstadoDaSessao.carregando => const Tela(corpo: SizedBox.shrink()),
        EstadoDaSessao.semPetshop => EscolherPetshop(sessao: _sessao),
        EstadoDaSessao.semConta => Entrar(sessao: _sessao),
        EstadoDaSessao.semVinculo => Vincular(sessao: _sessao),
        EstadoDaSessao.pronta => Inicio(sessao: _sessao),
      };
}
