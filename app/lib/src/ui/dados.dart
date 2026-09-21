import 'package:flutter/material.dart';

import '../api/portal_error.dart';
import 'superficies.dart';
import 'tema.dart';

/// A frase que a tela mostra quando a chamada falha.
///
/// O texto do `problem+json` já foi escrito para o cliente final — "peso e porte são
/// atualizados pelo estabelecimento" —, então ele atravessa sem reescrita. O que não é
/// `PortalError` é rede, e aí a frase precisa dizer o que a pessoa pode fazer a respeito.
String mensagemDoErro(Object erro) {
  if (erro is PortalError) return erro.message;
  return 'Não foi possível falar com o estabelecimento agora. '
      'Verifique a conexão e tente de novo.';
}

/// Uma tela que depende do servidor: girando, falha com saída, ou o dado.
///
/// Existe para que nenhuma tela reescreva os três estados — e principalmente para que
/// nenhuma esqueça o do meio. Uma tela que só trata "carregando" e "pronto" mostra um
/// giro eterno quando o 4G cai, que é o pior dos três desfechos: não diz o que houve
/// nem oferece o que fazer.
///
/// `construir` deve devolver algo **rolável** (`ListView`, `CustomScrollView`): é o que
/// dá o puxar-para-atualizar, que num app é como se pede de novo.
class CarregarDados<T> extends StatefulWidget {
  const CarregarDados({super.key, required this.buscar, required this.construir});

  final Future<T> Function() buscar;

  /// O `recarregar` chega ao filho de propósito: quem salvou uma edição precisa pedir a
  /// ficha de novo, e o servidor é quem diz como ela ficou.
  final Widget Function(BuildContext contexto, T dado, Future<void> Function() recarregar)
      construir;

  @override
  State<CarregarDados<T>> createState() => _CarregarDadosState<T>();
}

class _CarregarDadosState<T> extends State<CarregarDados<T>> {
  late Future<T> _futuro = widget.buscar();

  /// O `RefreshIndicator` espera este futuro para recolher a rosquinha, e um futuro que
  /// termina em erro aqui viraria exceção não tratada — o erro já vai para a tela pelo
  /// `FutureBuilder`, então aqui ele só precisa ser aguardado.
  ///
  /// O corpo do `setState` é **de chaves**, e não de seta, e isso não é estilo: um corpo
  /// de seta devolve o valor da atribuição, então `setState(() => _futuro = novo)`
  /// entrega um `Future` ao `setState` — que o Flutter proíbe, com um assert que só
  /// existe em depuração. O sintoma seria um quadro vermelho no primeiro
  /// puxar-para-atualizar de quem desenvolve, e nada em produção: o jeito mais caro de
  /// descobrir. Quem apanhou isto foi `test/telas_pets_test.dart`.
  Future<void> _recarregar() {
    final novo = widget.buscar();
    setState(() {
      _futuro = novo;
    });
    return novo.then((_) {}, onError: (_) {});
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _futuro,
      builder: (context, instantaneo) {
        if (instantaneo.connectionState != ConnectionState.done) {
          return const Center(child: Girando());
        }
        if (instantaneo.hasError) {
          return _Falha(erro: instantaneo.error!, aoTentarDeNovo: _recarregar);
        }
        return RefreshIndicator(
          onRefresh: _recarregar,
          child: widget.construir(context, instantaneo.data as T, _recarregar),
        );
      },
    );
  }
}

class _Falha extends StatelessWidget {
  const _Falha({required this.erro, required this.aoTentarDeNovo});

  final Object erro;
  final Future<void> Function() aoTentarDeNovo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 60, 20, 24),
      children: [
        Cartao(
          padding: const EdgeInsets.fromLTRB(22, 26, 22, 22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: ChipDeIcone(
                  Icons.wifi_tethering_error_rounded,
                  tamanho: 44,
                  fundo: t.perigoSuave,
                  aro: t.perigo.withValues(alpha: 0.22),
                  cor: t.perigo,
                ),
              ),
              const SizedBox(height: 16),
              Text('Não deu para carregar', style: tema.textTheme.titleMedium),
              const SizedBox(height: 6),
              Text(mensagemDoErro(erro), style: tema.textTheme.bodySmall),
              const SizedBox(height: 20),
              OutlinedButton(
                onPressed: () => aoTentarDeNovo(),
                child: const Text('Tentar de novo'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A espera.
///
/// Um anel só, na cor da marca, e o aro cinza por baixo dele — o indeterminado do
/// Material desenha um arco no vazio, que numa tela clara some. O aro é o que diz que
/// **há** algo girando ali, e não um traço solto passando.
class Girando extends StatelessWidget {
  const Girando({super.key, this.tamanho = 30});

  final double tamanho;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return SizedBox(
      width: tamanho,
      height: tamanho,
      child: CircularProgressIndicator(
        strokeWidth: 3,
        color: t.acento,
        backgroundColor: t.linha,
      ),
    );
  }
}
