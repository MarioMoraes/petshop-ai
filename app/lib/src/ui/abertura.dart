import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tema.dart';

/// A abertura do app: a marca se desenhando enquanto a sessão se resolve.
///
/// **Ela cobre uma espera que existe de verdade.** Entre o toque no ícone e a primeira
/// tela o app carrega o fuso, lê o cofre do sistema, pergunta o token à Clerk e faz duas
/// idas ao servidor — `GET /portal/v1/tenant` e `GET /portal/v1/me`. No 4G isso é um
/// segundo e meio em que a tela anterior era um disco girando no meio do cinza. O que
/// muda aqui não é o tempo: é o que se olha durante ele.
///
/// **A cortina fica por cima, e a tela de verdade nasce por baixo.** `child` é montado
/// desde o primeiro quadro, então quando a abertura sai não há troca de rota, não há
/// primeiro quadro a construir e nada pula — só uma camada que deixa de existir.
///
/// **A cor é a do estabelecimento, e ela chega no meio da animação.** Enquanto o slug
/// não foi respondido, o tema é o padrão do produto (`#E34A32`); quando o tenant chega,
/// `temaDoPetshop` muda e o `AnimatedTheme` do `MaterialApp` interpola os tokens — a
/// marca *vira* a cor do petshop no meio do desenho, em vez de piscar. É de graça
/// porque `TokensDoApp` implementa `lerp`.
///
/// **Nada aqui repete sozinho para sempre.** O anel de espera só começa a pulsar se a
/// entrada terminou e a sessão ainda não respondeu, e para quando ela responde: um
/// controlador em `repeat()` esquecido no ar é um `pumpAndSettle` que nunca volta, e a
/// suíte inteira do app passa por esta cortina.
class Abertura extends StatefulWidget {
  const Abertura({super.key, required this.pronto, required this.child});

  /// A sessão saiu de `carregando` — há uma tela de verdade para mostrar.
  final bool pronto;

  final Widget child;

  @override
  State<Abertura> createState() => _AberturaState();
}

class _AberturaState extends State<Abertura> with TickerProviderStateMixin {
  /// A entrada, que roda inteira mesmo que a sessão responda no primeiro quadro.
  ///
  /// Uma abertura que aparece por 200ms e some não é uma abertura, é um defeito de
  /// renderização — e o cache quente da segunda vez que o app abre é justamente o caso
  /// em que isso aconteceria.
  late final _entrada = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1250),
  );

  /// O halo que sai da marca enquanto a resposta não vem.
  late final _espera = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );

  late final _saida = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 380),
  );

  bool _foi = false;

  @override
  void initState() {
    super.initState();
    _entrada.addStatusListener((estado) {
      if (estado == AnimationStatus.completed) _reavaliar();
    });
    _saida.addStatusListener((estado) {
      if (estado != AnimationStatus.completed) return;
      _espera.stop();
      setState(() => _foi = true);
    });
    _entrada.forward();
  }

  @override
  void didUpdateWidget(Abertura anterior) {
    super.didUpdateWidget(anterior);
    if (widget.pronto != anterior.pronto) _reavaliar();
  }

  void _reavaliar() {
    // A entrada tem o tempo dela: cortá-la no meio porque a rede foi rápida devolve o
    // pisca-pisca que a cortina existe para tirar.
    if (!_entrada.isCompleted) return;
    if (!widget.pronto) {
      if (!_espera.isAnimating) _espera.repeat();
      return;
    }
    _espera.stop();
    if (_saida.isDismissed) _saida.forward();
  }

  @override
  void dispose() {
    _entrada.dispose();
    _espera.dispose();
    _saida.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // **A forma da árvore não muda quando a cortina sai** — só a cortina deixa a lista
    // de filhos.
    //
    // Devolver `widget.child` cru aqui, em vez do `Stack`, troca o tipo do widget nesta
    // posição: o Flutter desmonta a subárvore inteira e monta outra igual, e a tela de
    // baixo **perde o estado** no exato instante em que aparece. O sintoma era a tela
    // piscar duas vezes depois da abertura — o `CarregarDados` do "de que petshop se
    // fala" nascia de novo, voltava ao giro e refazia a chamada ao servidor que já
    // tinha respondido embaixo da cortina.
    //
    // Tirar o **último** filho de um `Stack` não mexe no primeiro, porque a
    // reconciliação é por posição. Por isso o `Transform` e o `AnimatedBuilder` de
    // baixo ficam para sempre, mesmo em repouso: eles custam uma matriz identidade por
    // quadro, e trocá-los por um `if` custaria a mesma remontagem.
    return Stack(
      fit: StackFit.expand,
      children: [
        // A tela de baixo **assenta** enquanto a cortina dissolve: entra 2,5% maior e
        // volta ao tamanho. É o que transforma o desaparecer da cortina em chegada da
        // tela — sem isso, a última coisa que o olho vê é uma camada sumindo, e não o
        // app abrindo. Um `Transform` puro, sem `Opacity`: a cortina é opaca e já faz a
        // travessia, e uma segunda camada translúcida custaria outro `saveLayer` no
        // quadro mais caro do app.
        AnimatedBuilder(
          animation: _saida,
          builder: (context, filho) => Transform.scale(
            scale: 1 + 0.025 * (1 - Curves.easeOutCubic.transform(_saida.value)),
            child: filho,
          ),
          child: widget.child,
        ),
        if (!_foi)
          AnimatedBuilder(
            animation: _saida,
            builder: (context, filho) => IgnorePointer(
              // Durante o esmaecer a cortina ainda está na frente: sem isto, o
              // primeiro toque na tela de baixo é engolido por uma camada que já não
              // se vê.
              ignoring: _saida.value > 0,
              child: Opacity(opacity: 1 - _saida.value, child: filho),
            ),
            child: _Cortina(entrada: _entrada, espera: _espera, saida: _saida),
          ),
      ],
    );
  }
}

/// O conteúdo da abertura: fundo, halo, marca e assinatura.
class _Cortina extends StatelessWidget {
  const _Cortina({
    required this.entrada,
    required this.espera,
    required this.saida,
  });

  final Animation<double> entrada;
  final Animation<double> espera;
  final Animation<double> saida;

  /// Um trecho da linha do tempo, normalizado e com curva.
  ///
  /// É o que deixa a coreografia legível numa linha por elemento em vez de em cinco
  /// `Tween`s com `Interval` — e o que permite ler a sequência de cima para baixo.
  static double _fase(double t, double inicio, double fim, [Curve curva = Curves.easeOutCubic]) =>
      curva.transform(((t - inicio) / (fim - inicio)).clamp(0.0, 1.0));

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final escuro = Theme.of(context).brightness == Brightness.dark;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: escuro ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      // `Material` porque a cortina não está dentro de um `Scaffold`: sem ele todo
      // `Text` daqui nasce com o sublinhado amarelo do modo de depuração, que é o
      // Flutter avisando que não há `DefaultTextStyle` nenhum acima.
      child: Material(
        type: MaterialType.transparency,
        child: DecoratedBox(
          decoration: BoxDecoration(gradient: t.fundo),
          child: AnimatedBuilder(
            animation: Listenable.merge([entrada, espera, saida]),
            builder: (context, _) {
              final p = entrada.value;

              // **A espera respira, e não gira.** Enquanto a sessão não responde, o
              // halo incha e volta num ciclo só de seno — que fecha onde começou, então
              // a repetição não tem emenda. Um anel saindo da marca foi tentado antes e
              // desenhava uma borda dura em volta dela a cada volta; um disco girando
              // ao lado seria um segundo assunto no meio de uma abertura.
              final respiro =
                  espera.isAnimating ? math.sin(espera.value * 2 * math.pi) : 0.0;

              // O halo abre antes de tudo: a luz chega, e a marca chega dentro dela.
              final halo = _fase(p, 0, 0.34);
              // A marca pousa, e ao pousar dá o carimbo — 3% para dentro e de volta.
              final entra = _fase(p, 0.04, 0.42, Curves.easeOutCubic);
              final carimbo = math.sin(_fase(p, 0.62, 0.78, Curves.linear) * math.pi);
              final escala = (0.82 + 0.18 * entra) *
                      (1 - 0.035 * carimbo) *
                      (1 + 0.012 * respiro) +
                  0.04 * _saidaDaMarca;
              // O nome sobe por último, e é nele que a abertura termina: a linha
              // "por PetShop AI" que morava embaixo saiu quando o app passou a se
              // chamar Meu PetShop AI — dizer o mesmo duas vezes não é assinatura, é
              // eco.
              final nome = _fase(p, 0.58, 0.94);


              return Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox.square(
                      dimension: 132,
                      child: Stack(
                        alignment: Alignment.center,
                        // O halo é maior que a caixa e **transborda**: reservar os 260px
                        // dele em layout empurrava o nome para meia tela abaixo da marca.
                        clipBehavior: Clip.none,
                        children: [
                          // O halo mora fora do `CustomPaint` da marca porque é maior que
                          // ela: pintar os dois no mesmo quadrado obrigaria a marca a
                          // reservar 240px de área para desenhar 116.
                          Opacity(
                            opacity: halo,
                            child: Transform.scale(
                              scale: 0.72 + 0.28 * halo,
                              child: _Halo(cor: t.brilhoDaMarca, acento: t.acento),
                            ),
                          ),
                          Opacity(
                            opacity: _fase(p, 0.04, 0.24),
                            child: Transform.scale(
                              scale: escala,
                              child: CustomPaint(
                                size: const Size.square(116),
                                painter: _PintorDaMarca(
                                  pata: _fase(p, 0.3, 0.72, Curves.easeInOutCubic),
                                  dedos: [
                                    _fase(p, 0.26, 0.42, Curves.easeOutBack),
                                    _fase(p, 0.33, 0.49, Curves.easeOutBack),
                                    _fase(p, 0.4, 0.56, Curves.easeOutBack),
                                  ],
                                  reflexo: _fase(p, 0.5, 0.86, Curves.easeInOut),
                                  acento: t.acento,
                                  sobre: t.sobreAcento,
                                  escuro: escuro,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 30),
                    Opacity(
                      opacity: nome,
                      child: Transform.translate(
                        offset: Offset(0, 14 * (1 - nome)),
                        // **O `AI` sai na cor da marca**, que é o tratamento que a
                        // landing dá ao nome (`.brand-ai`). Em `acentoTinta` e não em
                        // `acento`: a cor de um petshop pode ser clara, e o acento cru
                        // sobre o fundo quase branco some.
                        child: Text.rich(
                          TextSpan(
                            text: 'Meu PetShop ',
                            children: [
                              TextSpan(
                                text: 'AI',
                                style: TextStyle(color: t.acentoTinta),
                              ),
                            ],
                          ),
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 27,
                            fontWeight: FontWeight.w700,
                            // A letra chega espaçada e fecha: é o mesmo gesto de algo
                            // que se assenta, e não um segundo efeito.
                            letterSpacing: -0.6 + 7 * (1 - nome),
                            color: t.tinta,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  /// A marca cresce um fio ao sair, como quem se aproxima antes de virar a página.
  double get _saidaDaMarca => saida.value;
}

/// O halo da marca: o mesmo desenho do `BrilhoDaMarca` das telas, centrado.
class _Halo extends StatelessWidget {
  const _Halo({required this.cor, required this.acento});

  final Color cor;
  final Color acento;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: 300,
        height: 300,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            // Três paradas e nenhuma delas forte: o que se quer é a lembrança da cor
            // no fundo, e não um anel aceso em volta da peça.
            colors: [
              acento.withValues(alpha: 0.13),
              cor,
              acento.withValues(alpha: 0),
            ],
            stops: const [0, 0.5, 1],
          ),
        ),
      ),
    );
  }
}

/// A marca do produto, desenhada em vez de importada.
///
/// É a mesma geometria do `favicon.svg` da landing — a pastilha com a pata em traço
/// branco —, reescrita em `Path` por dois motivos. O primeiro é que um PNG não se
/// desenha sozinho: a pata que **se traça** depende de ter o caminho, não a imagem
/// dele. O segundo é que assim a pastilha usa o acento do tema, e não um laranja fixo:
/// num petshop de marca azul a abertura é azul.
///
/// As coordenadas são as do SVG (caixa de 32, ícone de 24 deslocado por `translate(5 5)
/// scale(.92)`), e o `canvas` é escalado uma vez no início — mexer nos números aqui é
/// mexer no mesmo desenho que a web mostra.
class _PintorDaMarca extends CustomPainter {
  _PintorDaMarca({
    required this.pata,
    required this.dedos,
    required this.reflexo,
    required this.acento,
    required this.sobre,
    required this.escuro,
  });

  /// 0..1 — quanto do coxim já foi traçado.
  final double pata;

  /// 0..1 por dedo, na ordem em que a pata os apoiaria.
  final List<double> dedos;

  /// 0..1 — a passagem do reflexo sobre o vidro da pastilha.
  final double reflexo;

  final Color acento;
  final Color sobre;
  final bool escuro;

  /// O coxim: `M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46
  /// 16.84A3.5 3.5 0 0 1 5.5 10Z` do SVG, arco por arco.
  static final Path _coxim = Path()
    ..moveTo(9, 10)
    ..relativeArcToPoint(const Offset(5, 5),
        radius: const Radius.circular(5), clockwise: true)
    ..lineTo(14, 18.5)
    ..relativeArcToPoint(const Offset(-6.84, 1.045),
        radius: const Radius.circular(3.5), clockwise: true)
    ..quadraticBezierTo(6.52, 17.48, 4.46, 16.84)
    ..arcToPoint(const Offset(5.5, 10),
        radius: const Radius.circular(3.5), clockwise: true)
    ..close();

  static const _posicoesDosDedos = [Offset(11, 4), Offset(18, 8), Offset(20, 16)];

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 32);

    final pastilha = RRect.fromRectAndRadius(
      const Rect.fromLTWH(0, 0, 32, 32),
      const Radius.circular(10),
    );

    // A sombra é da cor da marca, e não cinza: a peça é saturada, e uma sombra neutra
    // debaixo dela lê como sujeira em vez de luz.
    canvas.drawRRect(
      pastilha.deflate(1).shift(const Offset(0, 2.6)),
      Paint()
        ..color = acento.withValues(alpha: escuro ? 0.26 : 0.34)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3.4),
    );

    canvas.drawRRect(
      pastilha,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color.lerp(acento, Colors.white, 0.16)!, acento],
          stops: const [0, 0.7],
        ).createShader(const Rect.fromLTWH(0, 0, 32, 32)),
    );

    // O bisel de 1px: claro em cima, escuro embaixo. É o que separa uma pastilha de um
    // retângulo colorido, e é o mesmo par de `inset` que a landing usa no CSS.
    canvas.drawRRect(
      pastilha.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            Colors.white.withValues(alpha: 0.42),
            Colors.white.withValues(alpha: 0),
            // O escuro de baixo sai da **própria cor**, e não de um marrom fixo: sob
            // uma marca azul, o marrom do CSS da landing vira sujeira na borda.
            Color.lerp(acento, Colors.black, 0.6)!.withValues(alpha: 0.32),
          ],
          stops: const [0, 0.45, 1],
        ).createShader(const Rect.fromLTWH(0, 0, 32, 32)),
    );

    _desenharPata(canvas);
    _passarReflexo(canvas, pastilha);

    canvas.restore();
  }

  void _desenharPata(Canvas canvas) {
    canvas.save();
    canvas.translate(5, 5);
    canvas.scale(0.92);

    final tinta = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.9
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = sobre;

    for (var i = 0; i < _posicoesDosDedos.length; i++) {
      final k = dedos[i];
      if (k <= 0) continue;
      // O raio cresce e a espessura não: escalar o `canvas` engordaria o traço junto, e
      // o dedo chegaria gordo e emagreceria — que é o contrário de pousar.
      canvas.drawCircle(_posicoesDosDedos[i], 2 * k, tinta);
    }

    if (pata > 0) {
      // O coxim **se traça**, e não aparece: é a única parte do desenho com começo e
      // fim, e é ela que faz a marca parecer escrita à mão em vez de revelada.
      for (final medida in _coxim.computeMetrics()) {
        canvas.drawPath(
          medida.extractPath(0, medida.length * pata),
          tinta,
        );
      }
    }

    canvas.restore();
  }

  /// O reflexo que atravessa a pastilha em diagonal, uma vez só.
  ///
  /// Move os **pontos de parada** do degradê em vez de transladar uma faixa: assim a
  /// luz nasce e morre dentro da peça, sem um retângulo entrando por um canto.
  void _passarReflexo(Canvas canvas, RRect pastilha) {
    if (reflexo <= 0 || reflexo >= 1) return;

    final centro = -0.35 + reflexo * 1.7;
    final forca = math.sin(reflexo * math.pi) * 0.5;

    canvas.save();
    canvas.clipRRect(pastilha);
    canvas.drawRect(
      const Rect.fromLTWH(0, 0, 32, 32),
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Colors.white.withValues(alpha: 0),
            Colors.white.withValues(alpha: forca),
            Colors.white.withValues(alpha: 0),
          ],
          stops: [
            (centro - 0.18).clamp(0.0, 1.0),
            centro.clamp(0.0, 1.0),
            (centro + 0.18).clamp(0.0, 1.0),
          ],
        ).createShader(const Rect.fromLTWH(0, 0, 32, 32)),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_PintorDaMarca anterior) =>
      anterior.pata != pata ||
      anterior.dedos[0] != dedos[0] ||
      anterior.dedos[1] != dedos[1] ||
      anterior.dedos[2] != dedos[2] ||
      anterior.reflexo != reflexo ||
      anterior.acento != acento ||
      anterior.sobre != sobre;
}
