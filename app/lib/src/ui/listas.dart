import 'package:flutter/material.dart';

/// As peças de lista do app, traduzidas de `frontend/src/app/(portal)/list.tsx`.
///
/// A decisão que atravessa: **a linha inteira é o alvo**, e não um texto com um link no
/// fim. No celular o polegar acerta a linha, não as 14px do nome. E as linhas moram
/// dentro de um cartão só, com separador entre elas — uma pilha de cartões soltos custa
/// o mesmo espaço e não diz que os itens são da mesma lista.

/// Um cartão com linhas dentro, opcionalmente com cabeçalho de seção e rodapé.
class PilhaDeLinhas extends StatelessWidget {
  const PilhaDeLinhas({super.key, required this.filhos, this.cabecalho, this.rodape});

  final List<Widget> filhos;
  final Widget? cabecalho;
  final Widget? rodape;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (cabecalho != null)
          Padding(padding: const EdgeInsets.only(bottom: 12), child: cabecalho),
        if (filhos.isNotEmpty)
          Card(
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (var i = 0; i < filhos.length; i++) ...[
                  if (i > 0)
                    Divider(
                      height: 1,
                      thickness: 1,
                      indent: 16,
                      color: esquema.outlineVariant.withValues(alpha: 0.5),
                    ),
                  filhos[i],
                ],
              ],
            ),
          ),
        if (rodape != null)
          Padding(padding: const EdgeInsets.only(top: 12), child: rodape),
      ],
    );
  }
}

/// Uma linha da pilha. Com `aoTocar`, ela inteira responde ao toque e ganha a seta.
class Linha extends StatelessWidget {
  const Linha({super.key, required this.child, this.inicio, this.aoTocar});

  final Widget child;

  /// O retrato, a data, o que ancora o olho à esquerda.
  final Widget? inicio;

  final VoidCallback? aoTocar;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;

    final conteudo = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (inicio != null) ...[inicio!, const SizedBox(width: 14)],
          Expanded(child: child),
          if (aoTocar != null)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 2),
              child: Icon(Icons.chevron_right,
                  size: 20, color: esquema.onSurfaceVariant),
            ),
        ],
      ),
    );

    if (aoTocar == null) return conteudo;
    return InkWell(onTap: aoTocar, child: conteudo);
  }
}

/// O texto de uma linha: título, a dica que o descreve e o que vier embaixo.
class TextoDaLinha extends StatelessWidget {
  const TextoDaLinha({super.key, required this.titulo, this.dica, this.extra});

  final String titulo;
  final String? dica;
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(titulo,
            style: tema.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        if (dica != null && dica!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(dica!,
                style: tema.textTheme.bodySmall
                    ?.copyWith(color: tema.colorScheme.onSurfaceVariant)),
          ),
        if (extra != null) Padding(padding: const EdgeInsets.only(top: 6), child: extra),
      ],
    );
  }
}

/// O retrato do pet, ou a inicial dele.
///
/// A URL é assinada e vence — nada disto se guarda. A ausência é o caso **comum**, não a
/// exceção: a maioria das fichas nasce sem foto, e a inicial precisa parecer escolha, e
/// não buraco.
class Retrato extends StatelessWidget {
  const Retrato({super.key, required this.nome, this.url, this.tamanho = 48});

  final String nome;
  final String? url;
  final double tamanho;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;

    final inicial = Container(
      width: tamanho,
      height: tamanho,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: esquema.surfaceContainerHighest,
        shape: BoxShape.circle,
      ),
      child: Text(
        nome.isEmpty ? '?' : nome.characters.first.toUpperCase(),
        style: TextStyle(
          fontSize: tamanho * 0.38,
          fontWeight: FontWeight.w700,
          color: esquema.onSurfaceVariant,
        ),
      ),
    );

    if (url == null) return inicial;

    return ClipOval(
      child: Image.network(
        url!,
        width: tamanho,
        height: tamanho,
        fit: BoxFit.cover,
        // URL vencida, R2 fora do ar, aparelho sem rede: em todos, a inicial. Um ícone
        // de imagem quebrada não diz nada a quem está olhando o próprio cachorro.
        errorBuilder: (_, _, _) => inicial,
      ),
    );
  }
}

/// O cabeçalho de uma seção: o chip do ícone, o título e a explicação.
///
/// É o `<SectionHead>` do design do produto — um `<h2>` solto nunca foi opção, e o app
/// herda a regra porque o tutor que vir as duas telas precisa reconhecer a mesma casa.
class CabecalhoDeSecao extends StatelessWidget {
  const CabecalhoDeSecao({
    super.key,
    required this.icone,
    required this.titulo,
    this.descricao,
  });

  final IconData icone;
  final String titulo;
  final String? descricao;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: tema.colorScheme.primaryContainer,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icone, size: 18, color: tema.colorScheme.onPrimaryContainer),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(titulo,
                  style: tema.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w600)),
              if (descricao != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(descricao!,
                      style: tema.textTheme.bodySmall?.copyWith(
                        color: tema.colorScheme.onSurfaceVariant,
                        height: 1.4,
                      )),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Rótulo à esquerda, valor à direita — a linha de uma ficha de leitura.
class LinhaDeDado extends StatelessWidget {
  const LinhaDeDado({super.key, required this.rotulo, required this.valor});

  final String rotulo;
  final String valor;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 118,
            child: Text(rotulo,
                style: tema.textTheme.bodyMedium
                    ?.copyWith(color: tema.colorScheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(valor,
                style: tema.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500)),
          ),
        ],
      ),
    );
  }
}

/// A lista vazia que explica por que está vazia — e de quem é a próxima ação.
class EstadoVazio extends StatelessWidget {
  const EstadoVazio({
    super.key,
    required this.titulo,
    required this.descricao,
    this.icone = Icons.inbox_outlined,
  });

  final String titulo;
  final String descricao;
  final IconData icone;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
        child: Column(
          children: [
            Icon(icone, size: 32, color: tema.colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(titulo,
                textAlign: TextAlign.center,
                style: tema.textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(descricao,
                textAlign: TextAlign.center,
                style: tema.textTheme.bodySmall?.copyWith(
                  color: tema.colorScheme.onSurfaceVariant,
                  height: 1.45,
                )),
          ],
        ),
      ),
    );
  }
}
