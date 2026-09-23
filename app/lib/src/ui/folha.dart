import 'package:flutter/material.dart';

import 'comuns.dart';
import 'superficies.dart';
import 'tema.dart';

/// Abre uma folha inferior de formulário e devolve o que ela devolveu ao fechar.
///
/// É o `<Modal>` do produto no celular: formulário que responde a um registro que já está
/// na tela. `showDragHandle` e `useSafeArea` iguais em todas, para que nenhuma folha abra
/// com um formato diferente da anterior.
Future<T?> abrirFolha<T>(BuildContext context, WidgetBuilder construir) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: construir,
  );
}

/// O corpo de uma folha de formulário: cabeçalho, campos que rolam e a barra de ações
/// presa no rodapé.
///
/// Nasceu da edição do pet (`telas/pets/editar_pet.dart`), que tem a mesma construção
/// escrita à mão; Meus Dados tem quatro folhas, e quatro cópias da barra de ações
/// divergiriam na primeira correção de recorte de tela.
///
/// **Só os campos rolam.** Com os botões no fim da coluna rolada, "Salvar" nascia abaixo
/// da dobra da própria folha, e quem não descobrisse que dá para rolar fechava pela
/// cortina — sem saber que desistir tinha botão.
class FolhaDeFormulario extends StatelessWidget {
  const FolhaDeFormulario({
    super.key,
    required this.icone,
    required this.titulo,
    required this.filhos,
    required this.rotuloDaAcao,
    required this.aoConfirmar,
    this.descricao,
    this.base = Tons.gente,
    this.rotuloOcupado,
    this.ocupado = false,
    this.erro,
    this.aoVoltar,
  });

  final IconData icone;
  final String titulo;
  final String? descricao;

  /// O tom do assunto. Todas as folhas de Meus Dados usam `Tons.gente`, o do domínio
  /// Tutores — as mesmas cores dos `<Modal>` da página na web.
  final Color base;

  final List<Widget> filhos;
  final String rotuloDaAcao;
  final String? rotuloOcupado;

  /// Nulo desabilita o botão: falta preencher. É diferente de `ocupado`, que diz que a
  /// requisição está em voo.
  final VoidCallback? aoConfirmar;
  final bool ocupado;

  /// A frase do servidor, quando a gravação foi recusada. Vai no fim dos campos, perto
  /// do botão que a provocou.
  final String? erro;

  /// A seta de voltar ao passo anterior, quando a folha tem dois passos.
  final VoidCallback? aoVoltar;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return Padding(
      // O teclado sobe por cima da folha; sem isto, o campo em foco fica embaixo dele.
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (aoVoltar != null) ...[
                        IconButton(
                          tooltip: 'Voltar',
                          onPressed: ocupado ? null : aoVoltar,
                          icon: const Icon(Icons.arrow_back_rounded),
                        ),
                        const SizedBox(width: 4),
                      ] else ...[
                        ChipDeIcone(icone, tamanho: 40, base: base),
                        const SizedBox(width: 13),
                      ],
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(titulo, style: tema.textTheme.titleLarge),
                            if (descricao != null) ...[
                              const SizedBox(height: 3),
                              Text(descricao!, style: tema.textTheme.bodySmall),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  ...filhos,
                  if (erro != null) ...[
                    const SizedBox(height: 16),
                    Aviso(texto: erro!, erro: true),
                  ],
                ],
              ),
            ),
          ),

          // A barra de ações, presa no rodapé. Fundo próprio e um fio em cima porque ela
          // pousa sobre o que rola; "Cancelar" fica **ao lado** de quem grava, que tem o
          // dobro da largura — os dois não têm o mesmo peso.
          DecoratedBox(
            decoration: BoxDecoration(
              color: t.cartaoAlto,
              border: Border(top: BorderSide(color: t.linha)),
            ),
            child: Padding(
              // `paddingOf` e não `viewPaddingOf`: com o teclado aberto o recorte de baixo
              // já foi comido por ele, e o `Padding` de fora é quem responde.
              padding: EdgeInsets.fromLTRB(
                20,
                14,
                20,
                20 + MediaQuery.paddingOf(context).bottom,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: ocupado ? null : () => Navigator.of(context).pop(),
                      style: TextButton.styleFrom(minimumSize: const Size.fromHeight(54)),
                      child: const Text('Cancelar'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: BotaoPrincipal(
                      rotulo: rotuloDaAcao,
                      rotuloOcupado: rotuloOcupado,
                      ocupado: ocupado,
                      onPressed: aoConfirmar,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// O rótulo de um campo, acima dele.
///
/// Inter, e nunca a serifa de destaque: num formulário ela transformaria cada campo num
/// anúncio.
class RotuloDeCampo extends StatelessWidget {
  const RotuloDeCampo(this.texto, {super.key});

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        texto,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(
              fontSize: 13.5,
              color: context.tokens.tinta,
            ),
      ),
    );
  }
}

/// A frase de ajuda embaixo de um campo.
class DicaDeCampo extends StatelessWidget {
  const DicaDeCampo(this.texto, {super.key});

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        texto,
        style: Theme.of(context)
            .textTheme
            .bodySmall
            ?.copyWith(color: context.tokens.discreta),
      ),
    );
  }
}
