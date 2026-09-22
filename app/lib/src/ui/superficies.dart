import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'tema.dart';

/// As superfícies do app: o fundo de toda tela, o cartão e os painéis de destaque.
///
/// Elas moram fora das telas porque são **uma decisão só, repetida** — o dia em que a
/// sombra do cartão mudar, ela muda aqui, e não em onze arquivos que já divergiram.

/// O `Scaffold` do app, com o fundo do produto por baixo.
///
/// O degradê é pintado **pela tela**, e não pelo `MaterialApp`: uma rota que empilha
/// sobre a outra precisa ser opaca, senão a tela de baixo aparece por dentro da de cima
/// durante a transição. Cada `Tela` pinta o seu, e como todas pintam o mesmo, a
/// impressão é a de um fundo contínuo que as rotas atravessam.
class Tela extends StatelessWidget {
  const Tela({
    super.key,
    required this.corpo,
    this.appBar,
    this.fab,
    this.brilho = true,
  });

  final Widget corpo;
  final PreferredSizeWidget? appBar;

  /// A ação principal da tela, pousada sobre o corpo.
  ///
  /// Mora no `Scaffold`, e não dentro de `corpo`, porque é ele quem desconta a barra do
  /// sistema do canto inferior — a mesma conta que o `SafeArea` abaixo faz pelo corpo.
  final Widget? fab;

  /// O halo da marca no topo. Desligado nas telas que já têm um painel escuro ali — dois
  /// focos de luz na mesma dobra viram borrão.
  final bool brilho;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final escuro = Theme.of(context).brightness == Brightness.dark;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      // A barra de status é do app, e não do sistema: no claro os ícones precisam ser
      // escuros, senão somem no cinza quase branco do topo.
      value: escuro ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      child: DecoratedBox(
        decoration: BoxDecoration(gradient: t.fundo),
        child: Stack(
          children: [
            if (brilho)
              Positioned(
                top: -230,
                right: -140,
                child: BrilhoDaMarca(cor: t.brilhoDaMarca, tamanho: 520),
              ),
            Scaffold(
              backgroundColor: Colors.transparent,
              appBar: appBar,
              // **O rodapé do sistema entra na conta aqui, e numa vez só.**
              //
              // O `Scaffold` desconta a barra de status para quem tem `AppBar`, mas não
              // desconta a barra de navegação do corpo: a última linha da lista — o
              // "Ver mais", o botão que grava — nascia por baixo dela, e o aparelho
              // mostrava metade do alvo de toque. No emulador e nas capturas não
              // aparecia, porque lá o recorte é zero.
              //
              // `top: false` porque o topo já tem dono: a `AppBar` nas telas que a têm,
              // e o `SafeArea` da própria tela nas que não têm. `SafeArea` aninhado não
              // soma — o de dentro vê o recorte já consumido.
              body: SafeArea(top: false, child: corpo),
              floatingActionButton: fab,
            ),
          ],
        ),
      ),
    );
  }
}

/// O halo da cor do estabelecimento.
///
/// Um degradê radial, sem desfoque de verdade: `BackdropFilter` custa uma passada de
/// GPU por quadro em toda rolagem, e o que se quer aqui é só a lembrança da marca no
/// canto da tela — não um efeito que o aparelho de quem tem celular de entrada vai
/// pagar em quadros perdidos.
class BrilhoDaMarca extends StatelessWidget {
  const BrilhoDaMarca({super.key, required this.cor, this.tamanho = 420});

  final Color cor;
  final double tamanho;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: tamanho,
        height: tamanho,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [cor, cor.withValues(alpha: 0)],
            stops: const [0, 1],
          ),
        ),
      ),
    );
  }
}

/// O cartão: branco, borda de 1px e duas sombras.
///
/// Substitui o `Card` do Material nas telas. O `Card` desenha elevação com uma sombra
/// só, difusa, que sobre um fundo cinza vira mancha; aqui são duas camadas — o contato
/// curto logo abaixo da peça e a difusa larga mais abaixo —, que é o que dá a impressão
/// de uma folha pousada em vez de um retângulo com sombra.
class Cartao extends StatelessWidget {
  const Cartao({
    super.key,
    required this.child,
    this.padding,
    this.aoTocar,
    this.realce = false,
    this.raio = Raio.cartao,
  });

  final Widget child;
  final EdgeInsetsGeometry? padding;
  final VoidCallback? aoTocar;

  /// O cartão que o olho precisa achar primeiro: a borda vira o aro da marca.
  final bool realce;

  final double raio;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final forma = BorderRadius.circular(raio);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: t.cartao,
        borderRadius: forma,
        border: Border.all(color: realce ? t.acentoAro : t.bordaDoCartao),
        boxShadow: t.sombraDoCartao,
      ),
      child: Material(
        type: MaterialType.transparency,
        borderRadius: forma,
        clipBehavior: Clip.antiAlias,
        child: aoTocar == null
            ? Padding(padding: padding ?? EdgeInsets.zero, child: child)
            : InkWell(
                onTap: aoTocar,
                child: Padding(padding: padding ?? EdgeInsets.zero, child: child),
              ),
      ),
    );
  }
}

/// O painel grafite, com o brilho da marca por dentro.
///
/// É a peça mais pesada do app e existe em dois lugares: a saudação do Início e o
/// desfecho do agendamento. Usá-la numa terceira tela tiraria dela o que a faz
/// funcionar — ser a única coisa escura na rolagem.
class PainelEscuro extends StatelessWidget {
  const PainelEscuro({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(22),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: t.gradienteEscuro,
        borderRadius: BorderRadius.circular(Raio.folha),
        boxShadow: t.sombraAlta,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(Raio.folha),
        child: Stack(
          children: [
            Positioned(
              top: -120,
              right: -80,
              child: BrilhoDaMarca(
                cor: t.acento.withValues(alpha: 0.38),
                tamanho: 300,
              ),
            ),
            Padding(padding: padding, child: child),
          ],
        ),
      ),
    );
  }
}

/// O chip do ícone: quadrado arredondado, fundo suave da marca e um aro de 1px.
///
/// O aro é o que lhe dá silhueta sobre o branco do cartão — sem ele o chip é uma mancha
/// pastel, e com ele é uma peça. Mesma construção dos chips de ícone do Admin.
class ChipDeIcone extends StatelessWidget {
  const ChipDeIcone(
    this.icone, {
    super.key,
    this.tamanho = 40,
    this.cor,
    this.fundo,
    this.aro,
    this.base,
  });

  final IconData icone;
  final double tamanho;
  final Color? cor;
  final Color? fundo;
  final Color? aro;

  /// A cor do **assunto** (`Tons.pet`, `Tons.tempo`), quando o chip fala de um domínio
  /// e não do estabelecimento. Sem ela, o chip é da marca.
  final Color? base;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final tom = base == null
        ? (fundo: t.acentoSuave, aro: t.acentoAro, cor: t.acentoTinta)
        : tonalDe(base!, Theme.of(context).brightness);

    return Container(
      width: tamanho,
      height: tamanho,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: fundo ?? tom.fundo,
        borderRadius: BorderRadius.circular(tamanho * 0.32),
        border: Border.all(color: aro ?? tom.aro),
      ),
      child: Icon(icone, size: tamanho * 0.46, color: cor ?? tom.cor),
    );
  }
}

/// A sobrancelha: o rótulo curto em versalete acima de um título.
///
/// `PRÓXIMOS`, `PASSO 1`, o nome do estabelecimento na tela de entrada. Diz de que
/// assunto é o bloco sem gastar o peso de um título — que é o que um segundo título
/// empilhado faria.
class Etiqueta extends StatelessWidget {
  const Etiqueta(this.texto, {super.key, this.cor});

  final String texto;
  final Color? cor;

  @override
  Widget build(BuildContext context) {
    return Text(
      texto.toUpperCase(),
      style: Theme.of(context).textTheme.labelMedium?.copyWith(color: cor),
    );
  }
}

/// O título de uma tela, em duas linhas de peso diferente.
///
/// Inter em peso 700 no título e Inter regular na explicação — a mesma dupla do nome do
/// pet e da descrição dele na ficha. O contraste é de **peso e corpo**, e não de
/// família: foi a escolha do usuário, e é a que mantém o app com uma voz só.
class TituloDaTela extends StatelessWidget {
  const TituloDaTela({
    super.key,
    required this.titulo,
    this.descricao,
    this.etiqueta,
  });

  final String titulo;
  final String? descricao;
  final String? etiqueta;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (etiqueta != null) ...[
          Etiqueta(etiqueta!, cor: t.acentoTinta),
          const SizedBox(height: 10),
        ],
        Text(titulo, style: tema.textTheme.headlineMedium),
        if (descricao != null) ...[
          const SizedBox(height: 8),
          Text(descricao!, style: tema.textTheme.bodyMedium),
        ],
      ],
    );
  }
}
