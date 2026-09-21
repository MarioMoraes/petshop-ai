import 'package:flutter/material.dart';

/// O botão que grava, com a espera visível.
///
/// `ocupado` desenha o giro e **desabilita**, que são coisas diferentes de `habilitado`:
/// um botão cinza porque falta preencher o formulário e um botão girando porque a
/// requisição está em voo contam histórias distintas, e trocá-las faz a pessoa tocar de
/// novo no que já está acontecendo.
class BotaoPrincipal extends StatelessWidget {
  const BotaoPrincipal({
    super.key,
    required this.rotulo,
    required this.onPressed,
    this.ocupado = false,
    this.rotuloOcupado,
  });

  final String rotulo;
  final String? rotuloOcupado;
  final VoidCallback? onPressed;
  final bool ocupado;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: ocupado ? null : onPressed,
      child: ocupado
          ? Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
                Text(rotuloOcupado ?? 'Aguarde…'),
              ],
            )
          : Text(rotulo),
    );
  }
}

/// Um aviso na tela. `erro` separa o que impede do que só informa.
///
/// `titulo` e `linhas` existem porque o aviso dos alertas clínicos é uma lista com
/// cabeçalho — e juntar tudo num texto só com `\n` faria o leitor de tela ler um
/// parágrafo onde há itens, além de esconder cada alerta dentro de uma string.
class Aviso extends StatelessWidget {
  const Aviso({
    super.key,
    this.texto,
    this.titulo,
    this.linhas = const [],
    this.erro = false,
    this.icone,
  }) : assert(texto != null || titulo != null || linhas.length > 0);

  final String? texto;
  final String? titulo;
  final List<String> linhas;
  final bool erro;
  final IconData? icone;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;
    final fundo = erro ? esquema.errorContainer : esquema.surfaceContainerHighest;
    final frente = erro ? esquema.onErrorContainer : esquema.onSurfaceVariant;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: fundo,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icone ?? (erro ? Icons.error_outline : Icons.info_outline),
              size: 20, color: frente),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (titulo != null)
                  Text(titulo!,
                      style: TextStyle(color: frente, fontWeight: FontWeight.w700)),
                if (texto != null)
                  Padding(
                    padding: EdgeInsets.only(top: titulo == null ? 0 : 4),
                    child: Text(texto!, style: TextStyle(color: frente, height: 1.4)),
                  ),
                for (final linha in linhas)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(linha, style: TextStyle(color: frente, height: 1.4)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A moldura das telas de entrada: marca do petshop em cima, conteúdo embaixo.
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
    final tema = Theme.of(context);

    return Scaffold(
      appBar: aoVoltar == null
          ? null
          : AppBar(leading: BackButton(onPressed: aoVoltar)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (logoUrl != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 20),
                      child: SizedBox(
                        height: 56,
                        child: Image.network(logoUrl!,
                            fit: BoxFit.contain,
                            errorBuilder: (_, _, _) => const SizedBox.shrink()),
                      ),
                    ),
                  if (nomeDoPetshop != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        nomeDoPetshop!.toUpperCase(),
                        style: tema.textTheme.labelMedium?.copyWith(
                          color: tema.colorScheme.primary,
                          letterSpacing: 1.2,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  Text(titulo, style: tema.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      )),
                  const SizedBox(height: 8),
                  Text(descricao, style: tema.textTheme.bodyMedium?.copyWith(
                        color: tema.colorScheme.onSurfaceVariant,
                        height: 1.5,
                      )),
                  const SizedBox(height: 28),
                  ...filhos,
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Uma escolha da lista: caixa de marcar, rótulo e o preço à direita.
///
/// É o `<Choice>` do design do produto — "nenhum controle nativo sem estilo". O alvo do
/// toque é a **linha inteira**, e não os 20px da caixinha: no celular a diferença entre
/// marcar um serviço e não marcar nada é essa.
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
    final esquema = tema.colorScheme;

    return InkWell(
      onTap: () => aoMudar(!marcada),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: marcada ? esquema.primary : esquema.outlineVariant,
            width: marcada ? 2 : 1,
          ),
          color: marcada ? esquema.primaryContainer.withValues(alpha: 0.25) : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              marcada ? Icons.check_box : Icons.check_box_outline_blank,
              size: 22,
              color: marcada ? esquema.primary : esquema.onSurfaceVariant,
            ),
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
                        child: Text(titulo,
                            style: tema.textTheme.bodyLarge
                                ?.copyWith(fontWeight: FontWeight.w500)),
                      ),
                      if (aDireita != null)
                        Padding(
                          padding: const EdgeInsets.only(left: 12),
                          child: Text(aDireita!,
                              style: tema.textTheme.bodyMedium
                                  ?.copyWith(fontWeight: FontWeight.w600)),
                        ),
                    ],
                  ),
                  if (descricao != null && descricao!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(descricao!,
                          style: tema.textTheme.bodySmall
                              ?.copyWith(color: esquema.onSurfaceVariant, height: 1.35)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// O cartão de uma pergunta do agendamento: cabeçalho de seção e o conteúdo embaixo.
class CartaoDeSecao extends StatelessWidget {
  const CartaoDeSecao({
    super.key,
    required this.cabecalho,
    required this.filhos,
  });

  final Widget cabecalho;
  final List<Widget> filhos;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [cabecalho, const SizedBox(height: 14), ...filhos],
        ),
      ),
    );
  }
}

/// Um selo curto: "Aguardando confirmação", "Cancelado", "Não compareceu".
///
/// Ele diz um **estado**, e não um valor — por isso é chip e não texto solto: numa linha
/// onde a mesma posição às vezes traz o preço, a forma precisa separar as duas coisas
/// sem que a pessoa tenha de ler para descobrir qual é.
class Selo extends StatelessWidget {
  const Selo({super.key, required this.texto, this.erro = false});

  final String texto;
  final bool erro;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;
    final fundo = erro ? esquema.errorContainer : esquema.surfaceContainerHighest;
    final frente = erro ? esquema.onErrorContainer : esquema.onSurfaceVariant;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: fundo,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        texto,
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: frente),
      ),
    );
  }
}
