import 'package:flutter/material.dart';

import 'superficies.dart';
import 'tema.dart';

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
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (cabecalho != null)
          Padding(padding: const EdgeInsets.only(bottom: 14), child: cabecalho),
        if (filhos.isNotEmpty)
          Cartao(
            child: Column(
              children: [
                for (var i = 0; i < filhos.length; i++) ...[
                  if (i > 0)
                    // O fio começa depois do retrato, e não na borda do cartão: alinhado
                    // ao texto, ele separa as linhas; encostado na borda, ele desenha uma
                    // grade — e a lista passa a parecer uma tabela.
                    Divider(height: 1, thickness: 1, indent: 20, endIndent: 20, color: t.linha),
                  filhos[i],
                ],
              ],
            ),
          ),
        if (rodape != null)
          Padding(padding: const EdgeInsets.only(top: 14), child: rodape),
      ],
    );
  }
}

/// Uma linha da pilha. Com `aoTocar`, ela inteira responde ao toque e ganha a seta.
class Linha extends StatelessWidget {
  const Linha({
    super.key,
    required this.child,
    this.inicio,
    this.aoTocar,
    this.aoCentro = false,
  });

  final Widget child;

  /// O retrato, a data, o que ancora o olho à esquerda.
  final Widget? inicio;

  final VoidCallback? aoTocar;

  /// Alinha o chip, o texto e a seta pelo **meio**, e não pelo topo.
  ///
  /// A linha de conteúdo — o pet com as pílulas, a entrada do histórico — cresce para
  /// baixo, e ali o topo é a única âncora estável: com o meio, o retrato subiria e
  /// desceria conforme o texto de cada linha. Já a linha de **menu** tem uma frase só, e
  /// alinhada pelo topo ela fica acima do centro do ícone e da seta — que é o
  /// desencontro que se vê de relance sem saber nomear.
  final bool aoCentro;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    final conteudo = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
      child: Row(
        crossAxisAlignment:
            aoCentro ? CrossAxisAlignment.center : CrossAxisAlignment.start,
        children: [
          if (inicio != null) ...[inicio!, const SizedBox(width: 14)],
          Expanded(child: child),
          if (aoTocar != null)
            Padding(
              // Os 2px de respiro existem para casar a seta com a **primeira linha** do
              // texto; centralizada, ela não precisa deles.
              padding: EdgeInsets.only(left: 10, top: aoCentro ? 0 : 2),
              child: Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: t.chip, shape: BoxShape.circle),
                child: Icon(Icons.chevron_right_rounded, size: 18, color: t.fraca),
              ),
            ),
        ],
      ),
    );

    if (aoTocar == null) return conteudo;
    return InkWell(
      onTap: aoTocar,
      splashColor: t.acento.withValues(alpha: 0.06),
      highlightColor: t.acento.withValues(alpha: 0.04),
      child: conteudo,
    );
  }
}

/// O texto de uma linha: título, o que o descreve e o que vier embaixo.
///
/// O descritivo vem de duas formas, e não é a mesma coisa. `dica` é **uma frase** — o
/// endereço do petshop, por exemplo. `meta` são **atributos soltos**, cada um em sua
/// pílula: espécie, raça, idade.
///
/// A diferença apareceu no aparelho. Enquanto "Cão · Labrador · 3 anos" era uma frase
/// só, a raça um pouco mais longa quebrava a linha no meio dos separadores, e o começo
/// da segunda linha era um `·` órfão — o texto parecia desalinhado sem que nada
/// estivesse errado. Em pílulas, o que sobra desce inteiro para a linha de baixo, e
/// cada atributo continua sendo uma coisa que se lê de relance.
class TextoDaLinha extends StatelessWidget {
  const TextoDaLinha({
    super.key,
    required this.titulo,
    this.dica,
    this.meta = const [],
    this.extra,
  });

  final String titulo;
  final String? dica;

  /// Os atributos, um por pílula. Vazios e nulos não entram — pílula em branco é pior
  /// que atributo ausente.
  final List<String?> meta;

  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final atributos =
        meta.where((v) => v != null && v.trim().isNotEmpty).cast<String>().toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(titulo, style: tema.textTheme.titleSmall?.copyWith(fontSize: 15.5)),
        if (atributos.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [for (final valor in atributos) PilulaDeAtributo(valor)],
            ),
          )
        else if (dica != null && dica!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              dica!,
              style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
            ),
          ),
        if (extra != null) Padding(padding: const EdgeInsets.only(top: 9), child: extra),
      ],
    );
  }
}

/// Um atributo em pílula: `Cão`, `Labrador`, `3 anos`.
///
/// Discreta de propósito — fundo de chip e texto fraco. Ela organiza a leitura, e não
/// disputa com o nome do pet, que é o que a pessoa procura ao descer a lista.
class PilulaDeAtributo extends StatelessWidget {
  const PilulaDeAtributo(this.texto, {super.key});

  final String texto;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: t.chip,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: t.linha),
      ),
      child: Text(
        texto,
        style: TextStyle(
          fontFamily: 'Inter',
          fontSize: 11.5,
          fontWeight: FontWeight.w500,
          color: t.fraca,
        ),
      ),
    );
  }
}

/// O retrato do pet, ou a inicial dele.
///
/// A URL é assinada e vence — nada disto se guarda. A ausência é o caso **comum**, não a
/// exceção: a maioria das fichas nasce sem foto, e a inicial precisa parecer escolha, e
/// não buraco. Por isso ela vem num disco com degradê da marca e um aro claro por fora,
/// que é a mesma silhueta que a foto ganha quando existe.
class Retrato extends StatelessWidget {
  const Retrato({super.key, required this.nome, this.url, this.tamanho = 48});

  final String nome;
  final String? url;
  final double tamanho;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    final inicial = Container(
      width: tamanho,
      height: tamanho,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [t.acentoSuave, t.acentoAro],
        ),
        shape: BoxShape.circle,
      ),
      child: Text(
        nome.isEmpty ? '?' : nome.characters.first.toUpperCase(),
        style: TextStyle(
          fontFamily: 'Inter',
          fontSize: tamanho * 0.38,
          fontWeight: FontWeight.w700,
          color: t.acentoTinta,
        ),
      ),
    );

    final foto = url == null
        ? inicial
        : ClipOval(
            child: Image.network(
              url!,
              width: tamanho,
              height: tamanho,
              fit: BoxFit.cover,
              // URL vencida, R2 fora do ar, aparelho sem rede: em todos, a inicial. Um
              // ícone de imagem quebrada não diz nada a quem está olhando o próprio
              // cachorro.
              errorBuilder: (_, _, _) => inicial,
            ),
          );

    return Container(
      width: tamanho,
      height: tamanho,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: t.bordaDoCartao),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF171719).withValues(alpha: 0.10),
            blurRadius: 10,
            offset: const Offset(0, 4),
            spreadRadius: -4,
          ),
        ],
      ),
      child: ClipOval(child: foto),
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
    this.etiqueta,
    this.aDireita,
    this.base,
  });

  final IconData icone;
  final String titulo;
  final String? descricao;

  /// A cor do assunto (`Tons.pet` nas telas do pet, `Tons.tempo` nas da agenda).
  ///
  /// "Um tom de ícone por formulário, o do domínio no menu lateral, repetido em todas
  /// as seções" — a regra é do design do produto, e é o que faz a tela do app e a do
  /// Portal na web parecerem a mesma casa. Sem ela, o chip fica na cor da marca.
  final Color? base;

  /// `PASSO 2`, e o que mais for ordem e não explicação. Vai acima do título, em
  /// versalete: espremido na linha da descrição, ele disputava a leitura com o que a
  /// seção de fato pede.
  final String? etiqueta;

  final Widget? aDireita;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ChipDeIcone(icone, tamanho: 38, base: base),
        const SizedBox(width: 13),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (etiqueta != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Etiqueta(
                    etiqueta!,
                    // A sobrancelha acompanha o chip: com o chip azul da agenda e o
                    // "PASSO 1" no vermelho da marca, a mesma linha dizia duas cores.
                    cor: base == null
                        ? t.acentoTinta
                        : tonalDe(base!, Theme.of(context).brightness).cor,
                  ),
                ),
              Text(titulo, style: tema.textTheme.titleMedium),
              if (descricao != null)
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(descricao!, style: tema.textTheme.bodySmall),
                ),
            ],
          ),
        ),
        ?aDireita,
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
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 116,
            child: Text(
              rotulo,
              style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
            ),
          ),
          Expanded(
            child: Text(
              valor,
              style: tema.textTheme.bodyMedium?.copyWith(
                color: t.tinta,
                fontWeight: FontWeight.w500,
              ),
            ),
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
    final t = context.tokens;

    return Cartao(
      padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 34),
      child: Column(
        children: [
          Container(
            width: 58,
            height: 58,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [t.acentoSuave, t.chip],
              ),
              border: Border.all(color: t.bordaDoCartao),
            ),
            child: Icon(icone, size: 25, color: t.acentoTinta),
          ),
          const SizedBox(height: 16),
          Text(titulo, textAlign: TextAlign.center, style: tema.textTheme.titleMedium),
          const SizedBox(height: 7),
          Text(
            descricao,
            textAlign: TextAlign.center,
            style: tema.textTheme.bodySmall?.copyWith(height: 1.55),
          ),
        ],
      ),
    );
  }
}
