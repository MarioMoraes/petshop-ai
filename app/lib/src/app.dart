import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'auth/sessao.dart';
import 'telas/entrar.dart';
import 'telas/escolher_petshop.dart';
import 'telas/inicio.dart';
import 'telas/vincular.dart';
import 'ui/dados.dart';
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

  @override
  void initState() {
    super.initState();
    _sessao.iniciar();
  }

  @override
  void dispose() {
    _sessao.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _sessao,
      builder: (context, _) {
        final brilho = MediaQuery.platformBrightnessOf(context);
        return MaterialApp(
          title: 'Meu Petshop',
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
          home: _tela(),
        );
      },
    );
  }

  Widget _tela() => switch (_sessao.estado) {
        EstadoDaSessao.carregando =>
          const Tela(corpo: Center(child: Girando())),
        EstadoDaSessao.semPetshop => EscolherPetshop(sessao: _sessao),
        EstadoDaSessao.semConta => Entrar(sessao: _sessao),
        EstadoDaSessao.semVinculo => Vincular(sessao: _sessao),
        EstadoDaSessao.pronta => Inicio(sessao: _sessao),
      };
}
