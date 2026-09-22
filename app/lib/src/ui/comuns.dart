import 'package:flutter/material.dart';

import 'superficies.dart';
import 'tema.dart';

/// O botão que grava, com a espera visível.
///
/// `ocupado` desenha o giro e **desabilita**, que são coisas diferentes de `habilitado`:
/// um botão cinza porque falta preencher o formulário e um botão girando porque a
/// requisição está em voo contam histórias distintas, e trocá-las faz a pessoa tocar de
/// novo no que já está acontecendo.
///
/// É escuro e tem degradê, sombra e um afundar de 2% no toque. Nenhuma dessas três
/// coisas é enfeite: o degradê dá material ao retângulo, a sombra o descola do cartão, e
/// o afundar é a resposta que um botão sem estado de pressão não dá — num celular, o
/// dedo cobre justamente o que mudaria de cor.
class BotaoPrincipal extends StatefulWidget {
  const BotaoPrincipal({
    super.key,
    required this.rotulo,
    required this.onPressed,
    this.ocupado = false,
    this.rotuloOcupado,
    this.icone,
  });

  final String rotulo;
  final String? rotuloOcupado;
  final VoidCallback? onPressed;
  final bool ocupado;
  final IconData? icone;

  @override
  State<BotaoPrincipal> createState() => _BotaoPrincipalState();
}

class _BotaoPrincipalState extends State<BotaoPrincipal> {
  bool _pressionado = false;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final habilitado = widget.onPressed != null && !widget.ocupado;
    final forma = BorderRadius.circular(Raio.acao);
    final frente = habilitado || widget.ocupado ? t.sobreBotao : t.discreta;

    return AnimatedScale(
      scale: _pressionado ? 0.98 : 1,
      duration: const Duration(milliseconds: 90),
      curve: Curves.easeOut,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: habilitado || widget.ocupado ? t.gradienteDoBotao : null,
          color: habilitado || widget.ocupado ? null : t.chip,
          borderRadius: forma,
          boxShadow: habilitado ? t.sombraDoBotao : null,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: habilitado ? widget.onPressed : null,
            onTapDown: habilitado ? (_) => setState(() => _pressionado = true) : null,
            onTapUp: habilitado ? (_) => setState(() => _pressionado = false) : null,
            onTapCancel:
                habilitado ? () => setState(() => _pressionado = false) : null,
            borderRadius: forma,
            splashColor: t.sobreBotao.withValues(alpha: 0.10),
            highlightColor: t.sobreBotao.withValues(alpha: 0.06),
            child: SizedBox(
              height: 54,
              child: Center(
                child: widget.ocupado
                    ? Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: frente,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Text(
                            widget.rotuloOcupado ?? 'Aguarde…',
                            style: _estilo(frente),
                          ),
                        ],
                      )
                    : Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          if (widget.icone != null) ...[
                            Icon(widget.icone, size: 19, color: frente),
                            const SizedBox(width: 10),
                          ],
                          Flexible(
                            child: Text(
                              widget.rotulo,
                              textAlign: TextAlign.center,
                              style: _estilo(frente),
                            ),
                          ),
                        ],
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  TextStyle _estilo(Color cor) => TextStyle(
        fontFamily: 'Inter',
        fontSize: 16,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.1,
        color: cor,
      );
}

/// O mesmo botão que grava, pousado sobre a lista.
///
/// **É a ação principal da tela, e por isso sai da barra do topo.** Na `AppBar` ela
/// disputava a linha com o título e ficava no canto que o polegar não alcança sem
/// trocar a mão de posição; flutuando no canto inferior ela fica onde o dedo já está,
/// e continua visível com a lista rolada.
///
/// Desenhado com os tokens do `BotaoPrincipal`, e não com o FAB de fábrica: o botão
/// que age é escuro em todo o produto, e um FAB na cor do acento abriria um segundo
/// dialeto de "aqui se toca" na mesma tela.
class BotaoFlutuante extends StatelessWidget {
  const BotaoFlutuante({
    super.key,
    required this.rotulo,
    required this.icone,
    required this.onPressed,
  });

  final String rotulo;
  final IconData icone;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: t.gradienteDoBotao,
        borderRadius: BorderRadius.circular(999),
        boxShadow: t.sombraDoBotao,
      ),
      child: FloatingActionButton.extended(
        onPressed: onPressed,
        // O fundo é do `DecoratedBox`: o FAB do Material não aceita degradê, e uma cor
        // chapada apagaria o que separa o botão de um retângulo preto.
        backgroundColor: Colors.transparent,
        foregroundColor: t.sobreBotao,
        elevation: 0,
        focusElevation: 0,
        hoverElevation: 0,
        highlightElevation: 0,
        splashColor: t.sobreBotao.withValues(alpha: 0.10),
        shape: const StadiumBorder(),
        icon: Icon(icone, size: 20),
        label: Text(
          rotulo,
          style: TextStyle(
            fontFamily: 'Inter',
            fontSize: 15,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.1,
            color: t.sobreBotao,
          ),
        ),
      ),
    );
  }
}

/// O tom de um aviso — o que ele é antes de ser lido.
///
/// `atencao` é o degrau que faltava entre o cinza e o vermelho: a alergia de um pet
/// não impede nada — então não é erro —, mas um aviso clínico em cinza de legenda é um
/// aviso que ninguém lê. O âmbar é o mesmo da família de ícones do Pets.
enum TomDoAviso { neutro, marca, atencao, sucesso, erro }

/// Um aviso na tela. `erro` separa o que impede do que só informa.
///
/// `titulo` e `linhas` existem porque o aviso dos alertas clínicos é uma lista com
/// cabeçalho — e juntar tudo num texto só com `\n` faria o leitor de tela ler um
/// parágrafo onde há itens, além de esconder cada alerta dentro de uma string.
///
/// O ícone ganhou um chip próprio: numa caixa de fundo pastel, um ícone solto do mesmo
/// matiz do texto some no fundo, e o aviso passa a parecer um parágrafo recuado.
class Aviso extends StatelessWidget {
  const Aviso({
    super.key,
    this.texto,
    this.titulo,
    this.linhas = const [],
    this.erro = false,
    this.icone,
    this.tom,
  }) : assert(texto != null || titulo != null || linhas.length > 0);

  final String? texto;
  final String? titulo;
  final List<String> linhas;
  final bool erro;
  final IconData? icone;

  /// Quando o aviso não é nem neutro nem erro — a confirmação verde, o destaque da
  /// marca. `erro: true` continua valendo e vence, porque é o que as telas já dizem.
  final TomDoAviso? tom;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final tema = Theme.of(context);
    final qual = erro ? TomDoAviso.erro : (tom ?? TomDoAviso.neutro);

    final (fundo, aro, frente, tintaDoIcone) = switch (qual) {
      TomDoAviso.erro => (t.perigoSuave, t.perigo.withValues(alpha: 0.22), t.perigo, t.perigo),
      TomDoAviso.sucesso => (
          t.sucessoSuave,
          t.sucesso.withValues(alpha: 0.22),
          t.sucesso,
          t.sucesso
        ),
      TomDoAviso.marca => (t.acentoSuave, t.acentoAro, t.acentoTinta, t.acentoTinta),
      TomDoAviso.atencao => () {
          final tom = tonalDe(Tons.pet, Theme.of(context).brightness);
          return (tom.fundo, tom.aro, tom.cor, tom.cor);
        }(),
      TomDoAviso.neutro => (t.chip, t.linha, t.fraca, t.discreta),
    };

    final icone = this.icone ?? (erro ? Icons.error_outline : Icons.info_outline);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: fundo,
        borderRadius: BorderRadius.circular(Raio.acao),
        border: Border.all(color: aro),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: t.cartao.withValues(alpha: 0.7),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(icone, size: 17, color: tintaDoIcone),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (titulo != null)
                  Text(
                    titulo!,
                    style: tema.textTheme.titleSmall?.copyWith(color: frente),
                  ),
                if (texto != null)
                  Padding(
                    padding: EdgeInsets.only(top: titulo == null ? 0 : 5),
                    child: Text(
                      texto!,
                      style: tema.textTheme.bodySmall?.copyWith(
                        color: frente,
                        height: 1.5,
                      ),
                    ),
                  ),
                for (final linha in linhas)
                  Padding(
                    padding: const EdgeInsets.only(top: 5),
                    child: Text(
                      linha,
                      style: tema.textTheme.bodySmall?.copyWith(
                        color: frente,
                        height: 1.5,
                      ),
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

/// A moldura das telas de entrada: a marca do petshop em cima, o formulário num cartão.
///
/// As três telas de entrada — escolher a conta, criar o acesso, achar o cadastro — são
/// as primeiras que o tutor vê, e é nelas que o app diz de quem ele é. Por isso a marca
/// aparece grande: o logo num cartão próprio, o nome em versalete e o título na serifa
/// de destaque do produto.
class MolduraDeEntrada extends StatelessWidget {
  const MolduraDeEntrada({
    super.key,
    required this.titulo,
    required this.descricao,
    required this.filhos,
    this.nomeDoPetshop,
    this.logoUrl,
    this.aoVoltar,
  });

  final String titulo;
  final String descricao;
  final List<Widget> filhos;
  final String? nomeDoPetshop;
  final String? logoUrl;
  final VoidCallback? aoVoltar;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Tela(
      appBar: aoVoltar == null
          ? null
          : AppBar(leading: BackButton(onPressed: aoVoltar)),
      corpo: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 28, 20, 36),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (logoUrl != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 22),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 12,
                          ),
                          decoration: BoxDecoration(
                            color: t.cartao,
                            borderRadius: BorderRadius.circular(Raio.acao),
                            border: Border.all(color: t.bordaDoCartao),
                            boxShadow: t.sombraDoCartao,
                          ),
                          child: SizedBox(
                            height: 40,
                            child: Image.network(
                              logoUrl!,
                              fit: BoxFit.contain,
                              errorBuilder: (_, _, _) => const SizedBox.shrink(),
                            ),
                          ),
                        ),
                      ),
                    ),
                  TituloDaTela(
                    etiqueta: nomeDoPetshop,
                    titulo: titulo,
                    descricao: descricao,
                  ),
                  const SizedBox(height: 26),
                  // O formulário mora num cartão: sobre o cinza do fundo, os campos
                  // soltos pareciam flutuar sem pertencer a nada.
                  Cartao(
                    padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: filhos,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Uma escolha da lista: a marca de seleção, o rótulo e o preço à direita.
///
/// É o `<Choice>` do design do produto — "nenhum controle nativo sem estilo". O alvo do
/// toque é a **linha inteira**, e não os 20px da caixinha: no celular a diferença entre
/// marcar um serviço e não marcar nada é essa.
///
/// A marca de seleção é desenhada, e não o `Icons.check_box` do Material: a caixinha
/// quadrada do Android é a peça mais datada de qualquer formulário, e o que se quer aqui
/// é a mesma pílula escura que o resto do app usa para dizer "escolhido".
class Escolha extends StatelessWidget {
  const Escolha({
    super.key,
    required this.marcada,
    required this.aoMudar,
    required this.titulo,
    this.descricao,
    this.aDireita,
  });

  final bool marcada;
  final ValueChanged<bool> aoMudar;
  final String titulo;
  final String? descricao;

  /// O preço, quase sempre. Fica na mesma linha do nome porque é o que decide a escolha.
  final String? aDireita;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final forma = BorderRadius.circular(Raio.acao);

    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        onTap: () => aoMudar(!marcada),
        borderRadius: forma,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            borderRadius: forma,
            border: Border.all(
              color: marcada ? t.acento : t.linha,
              width: marcada ? 1.6 : 1,
            ),
            color: marcada ? t.acentoSuave : t.cartao,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Marca(marcada: marcada),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Expanded(
                          child: Text(
                            titulo,
                            style: tema.textTheme.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                              color: t.tinta,
                            ),
                          ),
                        ),
                        if (aDireita != null)
                          Padding(
                            padding: const EdgeInsets.only(left: 12),
                            child: Text(
                              aDireita!,
                              style: tema.textTheme.titleSmall?.copyWith(
                                color: marcada ? t.acentoTinta : t.tinta,
                              ),
                            ),
                          ),
                      ],
                    ),
                    if (descricao != null && descricao!.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          descricao!,
                          style: tema.textTheme.bodySmall?.copyWith(height: 1.4),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Marca extends StatelessWidget {
  const _Marca({required this.marcada});

  final bool marcada;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 140),
      curve: Curves.easeOut,
      width: 22,
      height: 22,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: marcada ? t.acento : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(
          color: marcada ? t.acento : t.discreta.withValues(alpha: 0.6),
          width: marcada ? 1 : 1.4,
        ),
      ),
      child: marcada
          ? Icon(Icons.check_rounded, size: 15, color: t.sobreAcento)
          : const SizedBox.shrink(),
    );
  }
}

/// O cartão de uma pergunta do agendamento: cabeçalho de seção e o conteúdo embaixo.
class CartaoDeSecao extends StatelessWidget {
  const CartaoDeSecao({
    super.key,
    required this.cabecalho,
    required this.filhos,
    this.realce = false,
  });

  final Widget cabecalho;
  final List<Widget> filhos;

  /// O cartão que fecha o formulário — o "Tudo certo?" — ganha o aro da marca: é ele
  /// que o olho precisa achar depois de rolar três perguntas.
  final bool realce;

  @override
  Widget build(BuildContext context) {
    return Cartao(
      realce: realce,
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [cabecalho, const SizedBox(height: 16), ...filhos],
      ),
    );
  }
}

/// O tom de um selo — o estado que ele carrega.
enum TomDoSelo { neutro, marca, sucesso, erro }

/// Um selo curto: "Aguardando confirmação", "Cancelado", "Não compareceu".
///
/// Ele diz um **estado**, e não um valor — por isso é chip e não texto solto: numa linha
/// onde a mesma posição às vezes traz o preço, a forma precisa separar as duas coisas
/// sem que a pessoa tenha de ler para descobrir qual é.
class Selo extends StatelessWidget {
  const Selo({super.key, required this.texto, this.erro = false, this.tom, this.icone});

  final String texto;
  final bool erro;
  final TomDoSelo? tom;
  final IconData? icone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final qual = erro ? TomDoSelo.erro : (tom ?? TomDoSelo.neutro);

    final (fundo, frente, aro) = switch (qual) {
      TomDoSelo.erro => (t.perigoSuave, t.perigo, t.perigo.withValues(alpha: 0.24)),
      TomDoSelo.sucesso => (
          t.sucessoSuave,
          t.sucesso,
          t.sucesso.withValues(alpha: 0.24)
        ),
      TomDoSelo.marca => (t.acentoSuave, t.acentoTinta, t.acentoAro),
      TomDoSelo.neutro => (t.chip, t.fraca, t.linha),
    };

    return Container(
      padding: EdgeInsets.fromLTRB(icone == null ? 11 : 8, 5, 11, 5),
      decoration: BoxDecoration(
        color: fundo,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: aro),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icone != null) ...[
            Icon(icone, size: 13, color: frente),
            const SizedBox(width: 5),
          ],
          Text(
            texto,
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.1,
              color: frente,
            ),
          ),
        ],
      ),
    );
  }
}
