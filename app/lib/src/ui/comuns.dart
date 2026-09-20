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

/// Um aviso na tela. `tom` separa o que impede do que só informa.
class Aviso extends StatelessWidget {
  const Aviso({super.key, required this.texto, this.erro = false, this.icone});

  final String texto;
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
          Expanded(child: Text(texto, style: TextStyle(color: frente, height: 1.4))),
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
