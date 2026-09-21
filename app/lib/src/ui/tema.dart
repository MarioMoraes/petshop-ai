import 'package:flutter/material.dart';

/// O sistema visual do app, semeado pela cor do estabelecimento.
///
/// `brandColor` vem de `GET /portal/v1/tenant`, que é anônimo — a marca já está
/// disponível na primeira tela, antes de haver qualquer sessão. Um app do tutor que
/// parecesse igual em todo petshop perderia justamente o que o produto vende: é o
/// estabelecimento dele que está ali, não a plataforma.
///
/// **O que o tema herda da web** (`frontend/src/app/globals.css`, extraído de
/// `design/design-modelo.html`): neutros frios com um acento quente único, tudo em
/// cartão ou pílula, raios grandes, e sombra que **sugere** elevação em vez de
/// desenhá-la. Inter para o texto, Instrument Serif como voz de destaque.
///
/// **O que ele não herda é o Material 3 de fábrica.** `ColorScheme.fromSeed` sozinho
/// pinta superfície, cartão e campo com a matiz da semente — o app inteiro fica com um
/// véu da cor da marca, que é o oposto de premium: a marca deixa de ser acento e vira
/// ambiente. Aqui a escala neutra é fixa e fria, e a marca aparece onde decide alguma
/// coisa — o chip do ícone, a seleção, o foco, o brilho do topo.

/// Os valores de desenho que o `ColorScheme` não comporta.
///
/// Sombra em camadas, gradiente de fundo, o brilho da marca, a borda branca do cartão:
/// nada disso cabe num par de cores, e espalhar esses números pelas telas é como duas
/// telas começam a divergir. Quem precisa deles chama `context.tokens`.
@immutable
class TokensDoApp extends ThemeExtension<TokensDoApp> {
  const TokensDoApp({
    required this.fundo,
    required this.brilhoDaMarca,
    required this.cartao,
    required this.cartaoAlto,
    required this.bordaDoCartao,
    required this.linha,
    required this.chip,
    required this.tinta,
    required this.fraca,
    required this.discreta,
    required this.acento,
    required this.acentoSuave,
    required this.acentoAro,
    required this.acentoTinta,
    required this.sobreAcento,
    required this.sucesso,
    required this.sucessoSuave,
    required this.perigo,
    required this.perigoSuave,
    required this.sombraDoCartao,
    required this.sombraAlta,
    required this.sombraDoBotao,
    required this.gradienteDoBotao,
    required this.sobreBotao,
    required this.gradienteEscuro,
    required this.escuro,
  });

  /// O plano de fundo de toda tela: dois passos de cinza frio, claro em cima.
  ///
  /// Um plano chapado de 800px lê como preenchimento; com a luz caindo de cima ele lê
  /// como superfície. É a mesma física da ficha de formulário da web, só que aqui o
  /// degradê pode ser ainda mais sutil porque a tela é alta e estreita.
  final LinearGradient fundo;

  /// O halo da cor da marca no topo da tela.
  ///
  /// Quente e de baixa opacidade, de propósito: sobre branco, um brilho **frio** não lê
  /// como luz, lê como sujeira — foi o que a tela de entrada da web já tinha ensinado.
  final Color brilhoDaMarca;

  final Color cartao;

  /// O cartão que precisa se destacar de outro cartão (a folha sobre a tela).
  final Color cartaoAlto;

  /// A borda de 1px do cartão. Clara sobre o cinza do fundo, ela recorta a peça sem
  /// desenhar uma moldura.
  final Color bordaDoCartao;

  final Color linha;
  final Color chip;

  final Color tinta;
  final Color fraca;
  final Color discreta;

  final Color acento;
  final Color acentoSuave;
  final Color acentoAro;

  /// O acento corrigido para ser **texto** — o mesmo matiz, escuro o bastante para
  /// passar no AA sobre `acentoSuave`. A cor da marca crua num rótulo de 13px é o jeito
  /// mais comum de um app bonito ficar ilegível.
  final Color acentoTinta;

  final Color sobreAcento;

  final Color sucesso;
  final Color sucessoSuave;
  final Color perigo;
  final Color perigoSuave;

  /// Duas camadas: um contato curto e escuro logo abaixo da peça, e uma difusa e larga
  /// mais abaixo. Uma sombra só, com raio grande, vira mancha cinza.
  final List<BoxShadow> sombraDoCartao;
  final List<BoxShadow> sombraAlta;
  final List<BoxShadow> sombraDoBotao;

  /// O botão que grava é **escuro**, e com duas paradas — é a decisão do design do
  /// produto ("botão é escuro"), e o degradê é o que o separa de um retângulo preto.
  final LinearGradient gradienteDoBotao;
  final Color sobreBotao;

  /// O painel grafite do topo do Início, e o que mais precisar de peso.
  final LinearGradient gradienteEscuro;
  final Color escuro;

  @override
  TokensDoApp copyWith({
    LinearGradient? fundo,
    Color? brilhoDaMarca,
    Color? cartao,
    Color? cartaoAlto,
    Color? bordaDoCartao,
    Color? linha,
    Color? chip,
    Color? tinta,
    Color? fraca,
    Color? discreta,
    Color? acento,
    Color? acentoSuave,
    Color? acentoAro,
    Color? acentoTinta,
    Color? sobreAcento,
    Color? sucesso,
    Color? sucessoSuave,
    Color? perigo,
    Color? perigoSuave,
    List<BoxShadow>? sombraDoCartao,
    List<BoxShadow>? sombraAlta,
    List<BoxShadow>? sombraDoBotao,
    LinearGradient? gradienteDoBotao,
    Color? sobreBotao,
    LinearGradient? gradienteEscuro,
    Color? escuro,
  }) {
    return TokensDoApp(
      fundo: fundo ?? this.fundo,
      brilhoDaMarca: brilhoDaMarca ?? this.brilhoDaMarca,
      cartao: cartao ?? this.cartao,
      cartaoAlto: cartaoAlto ?? this.cartaoAlto,
      bordaDoCartao: bordaDoCartao ?? this.bordaDoCartao,
      linha: linha ?? this.linha,
      chip: chip ?? this.chip,
      tinta: tinta ?? this.tinta,
      fraca: fraca ?? this.fraca,
      discreta: discreta ?? this.discreta,
      acento: acento ?? this.acento,
      acentoSuave: acentoSuave ?? this.acentoSuave,
      acentoAro: acentoAro ?? this.acentoAro,
      acentoTinta: acentoTinta ?? this.acentoTinta,
      sobreAcento: sobreAcento ?? this.sobreAcento,
      sucesso: sucesso ?? this.sucesso,
      sucessoSuave: sucessoSuave ?? this.sucessoSuave,
      perigo: perigo ?? this.perigo,
      perigoSuave: perigoSuave ?? this.perigoSuave,
      sombraDoCartao: sombraDoCartao ?? this.sombraDoCartao,
      sombraAlta: sombraAlta ?? this.sombraAlta,
      sombraDoBotao: sombraDoBotao ?? this.sombraDoBotao,
      gradienteDoBotao: gradienteDoBotao ?? this.gradienteDoBotao,
      sobreBotao: sobreBotao ?? this.sobreBotao,
      gradienteEscuro: gradienteEscuro ?? this.gradienteEscuro,
      escuro: escuro ?? this.escuro,
    );
  }

  @override
  TokensDoApp lerp(ThemeExtension<TokensDoApp>? outro, double t) {
    if (outro is! TokensDoApp) return this;
    return TokensDoApp(
      fundo: LinearGradient.lerp(fundo, outro.fundo, t)!,
      brilhoDaMarca: Color.lerp(brilhoDaMarca, outro.brilhoDaMarca, t)!,
      cartao: Color.lerp(cartao, outro.cartao, t)!,
      cartaoAlto: Color.lerp(cartaoAlto, outro.cartaoAlto, t)!,
      bordaDoCartao: Color.lerp(bordaDoCartao, outro.bordaDoCartao, t)!,
      linha: Color.lerp(linha, outro.linha, t)!,
      chip: Color.lerp(chip, outro.chip, t)!,
      tinta: Color.lerp(tinta, outro.tinta, t)!,
      fraca: Color.lerp(fraca, outro.fraca, t)!,
      discreta: Color.lerp(discreta, outro.discreta, t)!,
      acento: Color.lerp(acento, outro.acento, t)!,
      acentoSuave: Color.lerp(acentoSuave, outro.acentoSuave, t)!,
      acentoAro: Color.lerp(acentoAro, outro.acentoAro, t)!,
      acentoTinta: Color.lerp(acentoTinta, outro.acentoTinta, t)!,
      sobreAcento: Color.lerp(sobreAcento, outro.sobreAcento, t)!,
      sucesso: Color.lerp(sucesso, outro.sucesso, t)!,
      sucessoSuave: Color.lerp(sucessoSuave, outro.sucessoSuave, t)!,
      perigo: Color.lerp(perigo, outro.perigo, t)!,
      perigoSuave: Color.lerp(perigoSuave, outro.perigoSuave, t)!,
      sombraDoCartao: BoxShadow.lerpList(sombraDoCartao, outro.sombraDoCartao, t)!,
      sombraAlta: BoxShadow.lerpList(sombraAlta, outro.sombraAlta, t)!,
      sombraDoBotao: BoxShadow.lerpList(sombraDoBotao, outro.sombraDoBotao, t)!,
      gradienteDoBotao:
          LinearGradient.lerp(gradienteDoBotao, outro.gradienteDoBotao, t)!,
      sobreBotao: Color.lerp(sobreBotao, outro.sobreBotao, t)!,
      gradienteEscuro: LinearGradient.lerp(gradienteEscuro, outro.gradienteEscuro, t)!,
      escuro: Color.lerp(escuro, outro.escuro, t)!,
    );
  }
}

/// Os raios, num lugar só. Três degraus e nada entre eles: uma tela com cinco raios
/// diferentes não parece desenhada, parece montada.
class Raio {
  const Raio._();

  /// Campo, chip, botão pequeno.
  static const controle = 14.0;

  /// Botão que grava, chip de ícone grande.
  static const acao = 18.0;

  /// Cartão.
  static const cartao = 24.0;

  /// Folha inferior e painel de destaque.
  static const folha = 30.0;
}

/// A cor por assunto, a mesma do menu lateral do Admin.
///
/// Oito famílias derivadas com a **mesma clareza**, para que os ícones empilhados pesem
/// o mesmo — com clareza livre o verde salta e o ocre some. Ficam um degrau abaixo do
/// acento em saturação de propósito: a marca do estabelecimento continua sendo a coisa
/// mais alta da tela, e a cor do assunto informa sem disputar com ela.
///
/// O tutor que usa o Portal na web e o app precisa reconhecer o mesmo calendário azul
/// nos dois — a cor é o que faz a linha ser identificada antes de ser lida.
class Tons {
  const Tons._();

  static const pet = Color(0xFF966700);
  static const tempo = Color(0xFF466FBD);
  static const gente = Color(0xFF7E5DB1);
  static const dinheiro = Color(0xFF22864A);
  static const saude = Color(0xFFA94D79);
  static const sistema = Color(0xFF6E7179);
}

/// O trio de um chip de ícone: o fundo suave, o aro de 1px e a tinta do desenho.
///
/// No escuro nada disso pode ser o mesmo — um pastel claro sobre grafite vira um adesivo
/// aceso —, então o suave é a cor **afundada** no fundo, e a tinta sobe de clareza.
({Color fundo, Color aro, Color cor}) tonalDe(Color base, Brightness brilho) {
  if (brilho == Brightness.dark) {
    const fundoDoApp = Color(0xFF17181C);
    return (
      fundo: Color.lerp(base, fundoDoApp, 0.80)!,
      aro: Color.lerp(base, fundoDoApp, 0.58)!,
      cor: Color.lerp(base, Colors.white, 0.34)!,
    );
  }
  return (
    fundo: Color.lerp(base, Colors.white, 0.90)!,
    aro: Color.lerp(base, Colors.white, 0.74)!,
    cor: base,
  );
}

extension TemaDoApp on BuildContext {
  TokensDoApp get tokens => Theme.of(this).extension<TokensDoApp>()!;
}

/// **Uma família só, do rótulo ao título.**
///
/// A serifa de destaque da web (Instrument Serif) chegou a entrar na saudação do
/// Início, no título das telas de entrada e no desfecho do agendamento, e **saiu a
/// pedido do usuário em 2026-09-21**: num app a mistura de duas vozes lia como duas
/// peças coladas, e não como uma tela desenhada. O que dá hierarquia aqui é o Inter em
/// três pesos, com o entrelinha e o `letterSpacing` apertando conforme o corpo cresce —
/// o mesmo desenho do nome do pet na ficha, que é a referência que o usuário escolheu.
const _familia = 'Inter';

ThemeData temaDoPetshop(String? brandColor, Brightness brilho) {
  final marca = _corDe(brandColor) ?? const Color(0xFFE34A32);
  final escuro = brilho == Brightness.dark;

  final tokens = escuro ? _tokensEscuros(marca) : _tokensClaros(marca);
  final esquema = _esquema(marca, brilho, tokens);
  final texto = _texto(tokens);

  return ThemeData(
    colorScheme: esquema,
    useMaterial3: true,
    fontFamily: _familia,
    textTheme: texto,
    // O fundo é pintado pela `Tela` (`ui/superficies.dart`), que é quem sabe desenhar o
    // degradê e o brilho da marca. O `Scaffold` fica com a cor de base para o caso de
    // alguma superfície do Material aparecer antes dela.
    scaffoldBackgroundColor: tokens.fundo.colors.last,
    canvasColor: tokens.cartao,
    splashFactory: InkSparkle.splashFactory,
    // A mesma transição nas duas plataformas, e a do iOS nas duas: a tela desliza e a
    // de baixo acompanha. A do Android abre com zoom, que num app de cartões grandes
    // faz a lista inteira pulsar a cada toque — e de quebra o deslizar da borda para
    // voltar passa a existir, que é como metade das pessoas volta hoje.
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      },
    ),
    extensions: [tokens],
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      foregroundColor: tokens.tinta,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: texto.titleMedium?.copyWith(
        fontWeight: FontWeight.w600,
        letterSpacing: -0.1,
      ),
    ),
    // Botão escuro com degradê é peça própria (`BotaoPrincipal`); este tema é o piso
    // para os `FilledButton` que aparecem soltos — o horário escolhido da grade, por
    // exemplo — e por isso já nasce com a mesma cor e o mesmo raio.
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: tokens.escuro,
        foregroundColor: tokens.sobreBotao,
        minimumSize: const Size.fromHeight(54),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Raio.acao),
        ),
        textStyle: const TextStyle(
          fontFamily: _familia,
          fontSize: 16,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.1,
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: tokens.tinta,
        backgroundColor: tokens.cartao,
        minimumSize: const Size.fromHeight(50),
        side: BorderSide(color: tokens.linha),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Raio.acao),
        ),
        textStyle: const TextStyle(
          fontFamily: _familia,
          fontSize: 15,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: tokens.fraca,
        textStyle: const TextStyle(
          fontFamily: _familia,
          fontSize: 14.5,
          fontWeight: FontWeight.w600,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Raio.controle),
        ),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: escuro ? tokens.chip : const Color(0xFFF7F8F9),
      hintStyle: TextStyle(color: tokens.discreta, fontWeight: FontWeight.w400),
      prefixIconColor: tokens.discreta,
      suffixIconColor: tokens.discreta,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Raio.acao),
        borderSide: BorderSide(color: tokens.linha),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Raio.acao),
        borderSide: BorderSide(color: tokens.linha),
      ),
      // O foco é a **marca**, com dois pixels: num formulário de celular, o campo em
      // foco é a única coisa que diz onde o teclado vai escrever.
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Raio.acao),
        borderSide: BorderSide(color: tokens.acento, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Raio.acao),
        borderSide: BorderSide(color: tokens.perigo),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Raio.acao),
        borderSide: BorderSide(color: tokens.perigo, width: 2),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 17),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: tokens.cartao,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Raio.cartao),
        side: BorderSide(color: tokens.bordaDoCartao),
      ),
      margin: EdgeInsets.zero,
    ),
    dividerTheme: DividerThemeData(
      color: tokens.linha,
      thickness: 1,
      space: 1,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: tokens.cartaoAlto,
      surfaceTintColor: Colors.transparent,
      modalBarrierColor: escuro ? const Color(0xB3000000) : const Color(0x59171719),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Raio.folha)),
      ),
      dragHandleColor: tokens.linha,
      dragHandleSize: const Size(44, 4),
      showDragHandle: true,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: tokens.cartaoAlto,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Raio.folha),
      ),
    ),
    datePickerTheme: DatePickerThemeData(
      backgroundColor: tokens.cartaoAlto,
      surfaceTintColor: Colors.transparent,
      headerBackgroundColor: tokens.escuro,
      headerForegroundColor: tokens.sobreBotao,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Raio.folha),
      ),
      todayBorder: BorderSide(color: tokens.acento),
      dayShape: const WidgetStatePropertyAll(CircleBorder()),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith((estados) =>
            estados.contains(WidgetState.selected) ? tokens.escuro : tokens.cartao),
        foregroundColor: WidgetStateProperty.resolveWith((estados) =>
            estados.contains(WidgetState.selected) ? tokens.sobreBotao : tokens.fraca),
        side: WidgetStatePropertyAll(BorderSide(color: tokens.linha)),
        textStyle: const WidgetStatePropertyAll(TextStyle(
          fontFamily: _familia,
          fontSize: 14,
          fontWeight: FontWeight.w600,
        )),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Raio.controle),
        )),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        ),
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: tokens.acento,
      circularTrackColor: tokens.linha,
      strokeCap: StrokeCap.round,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: tokens.escuro,
      contentTextStyle: TextStyle(
        fontFamily: _familia,
        color: tokens.sobreBotao,
        fontSize: 14.5,
      ),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Raio.controle),
      ),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: tokens.acento,
      selectionColor: tokens.acento.withValues(alpha: 0.24),
      selectionHandleColor: tokens.acento,
    ),
    listTileTheme: ListTileThemeData(
      iconColor: tokens.fraca,
      textColor: tokens.tinta,
    ),
    iconTheme: IconThemeData(color: tokens.fraca, size: 22),
  );
}

/// A escala tipográfica.
///
/// Inter em todos os degraus, com o entrelinha apertando conforme o corpo cresce —
/// título com entrelinha de parágrafo parece solto, e parágrafo com entrelinha de
/// título parece espremido. O `letterSpacing` negativo nos títulos é o que faz o Inter
/// grande parecer desenhado em vez de esticado.
TextTheme _texto(TokensDoApp t) {
  TextStyle e(double tamanho, FontWeight peso,
          {double? altura, double? espaco, Color? cor}) =>
      TextStyle(
        fontFamily: _familia,
        fontSize: tamanho,
        fontWeight: peso,
        height: altura,
        letterSpacing: espaco,
        color: cor ?? t.tinta,
      );

  return TextTheme(
    displaySmall: e(34, FontWeight.w700, altura: 1.1, espaco: -0.8),
    headlineMedium: e(28, FontWeight.w700, altura: 1.15, espaco: -0.6),
    headlineSmall: e(25, FontWeight.w700, altura: 1.18, espaco: -0.5),
    titleLarge: e(20, FontWeight.w700, altura: 1.25, espaco: -0.3),
    titleMedium: e(17, FontWeight.w600, altura: 1.3, espaco: -0.2),
    titleSmall: e(15, FontWeight.w600, altura: 1.35, espaco: -0.1),
    bodyLarge: e(16, FontWeight.w400, altura: 1.45),
    bodyMedium: e(14.5, FontWeight.w400, altura: 1.5, cor: t.fraca),
    bodySmall: e(13, FontWeight.w400, altura: 1.5, cor: t.fraca),
    labelLarge: e(14.5, FontWeight.w600, altura: 1.3),
    labelMedium: e(12, FontWeight.w700, altura: 1.3, espaco: 0.9, cor: t.discreta),
    labelSmall: e(11.5, FontWeight.w600, altura: 1.3, cor: t.discreta),
  );
}

ColorScheme _esquema(Color marca, Brightness brilho, TokensDoApp t) {
  return ColorScheme.fromSeed(seedColor: marca, brightness: brilho).copyWith(
    primary: t.acento,
    onPrimary: t.sobreAcento,
    primaryContainer: t.acentoSuave,
    onPrimaryContainer: t.acentoTinta,
    secondary: t.escuro,
    onSecondary: t.sobreBotao,
    surface: t.cartao,
    onSurface: t.tinta,
    onSurfaceVariant: t.fraca,
    surfaceContainerLowest: t.cartao,
    surfaceContainerLow: t.cartao,
    surfaceContainer: t.chip,
    surfaceContainerHigh: t.chip,
    surfaceContainerHighest: t.chip,
    outline: t.discreta,
    outlineVariant: t.linha,
    error: t.perigo,
    onError: Colors.white,
    errorContainer: t.perigoSuave,
    onErrorContainer: t.perigo,
    shadow: const Color(0xFF171719),
  );
}

TokensDoApp _tokensClaros(Color marca) {
  final acento = _legivelSobreClaro(marca);

  return TokensDoApp(
    fundo: const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFFFBFBFC), Color(0xFFF1F2F4), Color(0xFFEAEBEE)],
      stops: [0, 0.45, 1],
    ),
    brilhoDaMarca: acento.withValues(alpha: 0.11),
    cartao: Colors.white,
    cartaoAlto: Colors.white,
    bordaDoCartao: const Color(0xFFE6E7EA),
    linha: const Color(0xFFDFE0E2),
    chip: const Color(0xFFF4F5F7),
    tinta: const Color(0xFF232427),
    fraca: const Color(0xFF55585E),
    discreta: const Color(0xFF86888D),
    acento: acento,
    acentoSuave: Color.lerp(acento, Colors.white, 0.90)!,
    acentoAro: Color.lerp(acento, Colors.white, 0.72)!,
    acentoTinta: _escurecer(acento, 0.34),
    sobreAcento: _sobre(acento),
    sucesso: const Color(0xFF1F7A4D),
    sucessoSuave: const Color(0xFFE6F4EC),
    perigo: const Color(0xFFB4231B),
    perigoSuave: const Color(0xFFFDECEB),
    sombraDoCartao: const [
      BoxShadow(color: Color(0x0F171719), blurRadius: 2, offset: Offset(0, 1)),
      BoxShadow(
        color: Color(0x14171719),
        blurRadius: 24,
        spreadRadius: -12,
        offset: Offset(0, 12),
      ),
    ],
    sombraAlta: const [
      BoxShadow(color: Color(0x10171719), blurRadius: 3, offset: Offset(0, 1)),
      BoxShadow(
        color: Color(0x1F171719),
        blurRadius: 46,
        spreadRadius: -18,
        offset: Offset(0, 16),
      ),
    ],
    sombraDoBotao: const [
      BoxShadow(
        color: Color(0x40171719),
        blurRadius: 20,
        spreadRadius: -8,
        offset: Offset(0, 10),
      ),
    ],
    gradienteDoBotao: const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFF34363B), Color(0xFF17181A)],
    ),
    sobreBotao: Colors.white,
    gradienteEscuro: const LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [Color(0xFF2B2D33), Color(0xFF17181A)],
    ),
    escuro: const Color(0xFF171719),
  );
}

/// O modo escuro **não é o claro invertido**.
///
/// Sobre preto, a mesma sombra some e a mesma borda desaparece: o que separa um cartão
/// do fundo aqui é ele ser **mais claro** que o plano, e não mais elevado. O acento
/// também sobe de clareza — a cor da marca de um petshop costuma ser saturada e escura,
/// e crua sobre grafite ela não se lê.
TokensDoApp _tokensEscuros(Color marca) {
  final acento = _clarearParaEscuro(marca);

  return TokensDoApp(
    fundo: const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFF17181C), Color(0xFF101114), Color(0xFF0C0D0F)],
      stops: [0, 0.5, 1],
    ),
    brilhoDaMarca: acento.withValues(alpha: 0.16),
    cartao: const Color(0xFF1A1B1F),
    cartaoAlto: const Color(0xFF212328),
    bordaDoCartao: const Color(0x14FFFFFF),
    linha: const Color(0x1FFFFFFF),
    chip: const Color(0xFF24262B),
    tinta: const Color(0xFFF3F4F6),
    fraca: const Color(0xFFB2B5BC),
    discreta: const Color(0xFF878A92),
    acento: acento,
    acentoSuave: Color.lerp(acento, const Color(0xFF17181C), 0.82)!,
    acentoAro: Color.lerp(acento, const Color(0xFF17181C), 0.60)!,
    acentoTinta: Color.lerp(acento, Colors.white, 0.18)!,
    sobreAcento: _sobre(acento),
    sucesso: const Color(0xFF5FCB92),
    sucessoSuave: const Color(0xFF16291F),
    perigo: const Color(0xFFFF8A80),
    perigoSuave: const Color(0xFF2E1917),
    sombraDoCartao: const [
      BoxShadow(color: Color(0x40000000), blurRadius: 18, offset: Offset(0, 8)),
    ],
    sombraAlta: const [
      BoxShadow(color: Color(0x66000000), blurRadius: 32, offset: Offset(0, 16)),
    ],
    sombraDoBotao: const [
      BoxShadow(
        color: Color(0x59000000),
        blurRadius: 20,
        spreadRadius: -8,
        offset: Offset(0, 10),
      ),
    ],
    // No escuro o botão que grava **clareia** em vez de escurecer: um retângulo
    // grafite sobre um fundo grafite não é um botão, é um buraco.
    gradienteDoBotao: const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0xFFFAFAFA), Color(0xFFE2E3E6)],
    ),
    sobreBotao: const Color(0xFF17181A),
    gradienteEscuro: const LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [Color(0xFF2A2C32), Color(0xFF191A1E)],
    ),
    escuro: const Color(0xFFF4F5F6),
  );
}

/// `#E34A32` ou `E34A32`. Cor inválida cai no padrão, porque tema quebrado não é motivo
/// para a tela não abrir.
Color? _corDe(String? hex) {
  if (hex == null) return null;
  final limpo = hex.replaceAll('#', '').trim();
  if (limpo.length != 6) return null;
  final valor = int.tryParse(limpo, radix: 16);
  return valor == null ? null : Color(0xFF000000 | valor);
}

/// Preto ou branco sobre a cor, pelo que enxerga melhor.
Color _sobre(Color cor) =>
    cor.computeLuminance() > 0.55 ? const Color(0xFF17181A) : Colors.white;

/// A marca serve de acento sobre branco; amarelo-canário puro, não.
///
/// A cor não é trocada — o matiz do estabelecimento é o que o tutor reconhece —, só
/// rebaixada até o ponto em que um ícone de 18px sobre branco ainda tem silhueta.
Color _legivelSobreClaro(Color cor) {
  final hsl = HSLColor.fromColor(cor);
  if (hsl.lightness <= 0.62) return cor;
  return hsl.withLightness(0.55).toColor();
}

Color _clarearParaEscuro(Color cor) {
  final hsl = HSLColor.fromColor(cor);
  if (hsl.lightness >= 0.58) return cor;
  return hsl.withLightness(0.66).withSaturation(hsl.saturation * 0.92).toColor();
}

Color _escurecer(Color cor, double clareza) {
  final hsl = HSLColor.fromColor(cor);
  return hsl.withLightness(hsl.lightness < clareza ? hsl.lightness : clareza).toColor();
}
