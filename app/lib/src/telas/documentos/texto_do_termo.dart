import 'package:flutter/material.dart';

import '../../titulo.dart';
import '../../ui/tema.dart';

/// O texto do termo, desenhado a partir de blocos.
///
/// O corpo é **Markdown restrito** — título (`#`), parágrafo, lista (`-` ou `*`) e
/// negrito (`**assim**`) — e esta é a tradução de `parseTermBody`
/// (`packages/shared-types/src/terms.ts`), a mesma regra que a tela da web e o PDF do
/// aceite usam. O que se lê aqui tem de ser o que sai impresso: é esse texto que o
/// aceite prova.
///
/// Não há gerador para isto porque não é schema, é função — a tradução é à mão, e os
/// casos de `test/texto_do_termo_test.dart` são os que o parser de lá cobre.
class TextoDoTermo extends StatelessWidget {
  const TextoDoTermo({super.key, required this.corpo});

  final String corpo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final base = tema.textTheme.bodyMedium?.copyWith(color: t.tinta, height: 1.5);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final bloco in blocosDoTermo(corpo))
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: switch (bloco) {
              BlocoDoTermo(tipo: TipoDeBloco.titulo, :final trechos) => Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text.rich(
                    _texto(trechos),
                    style: tema.textTheme.labelMedium?.copyWith(color: t.fraca),
                  ),
                ),
              BlocoDoTermo(tipo: TipoDeBloco.paragrafo, :final trechos) =>
                Text.rich(_texto(trechos), style: base),
              BlocoDoTermo(:final itens) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final item in itens)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('•  ', style: base),
                            Expanded(child: Text.rich(_texto(item), style: base)),
                          ],
                        ),
                      ),
                  ],
                ),
            },
          ),
      ],
    );
  }

  static TextSpan _texto(List<TrechoDoTermo> trechos) => TextSpan(
        children: [
          for (final trecho in trechos)
            TextSpan(
              text: trecho.texto,
              style: trecho.negrito ? const TextStyle(fontWeight: FontWeight.w600) : null,
            ),
        ],
      );
}

enum TipoDeBloco { titulo, paragrafo, lista }

class TrechoDoTermo {
  const TrechoDoTermo(this.texto, {this.negrito = false});

  final String texto;
  final bool negrito;
}

class BlocoDoTermo {
  const BlocoDoTermo.titulo(this.trechos)
      : tipo = TipoDeBloco.titulo,
        itens = const [];
  const BlocoDoTermo.paragrafo(this.trechos)
      : tipo = TipoDeBloco.paragrafo,
        itens = const [];
  const BlocoDoTermo.lista(this.itens)
      : tipo = TipoDeBloco.lista,
        trechos = const [];

  final TipoDeBloco tipo;
  final List<TrechoDoTermo> trechos;
  final List<List<TrechoDoTermo>> itens;
}

/// `**assim**` vira negrito. O resto do texto passa inteiro.
List<TrechoDoTermo> _trechos(String linha) {
  final trechos = <TrechoDoTermo>[];
  final negrito = RegExp(r'\*\*[^*]+\*\*');
  var inicio = 0;
  for (final m in negrito.allMatches(linha)) {
    if (m.start > inicio) trechos.add(TrechoDoTermo(linha.substring(inicio, m.start)));
    final parte = m.group(0)!;
    trechos.add(
      parte.length > 4
          ? TrechoDoTermo(parte.substring(2, parte.length - 2), negrito: true)
          : TrechoDoTermo(parte),
    );
    inicio = m.end;
  }
  if (inicio < linha.length) trechos.add(TrechoDoTermo(linha.substring(inicio)));
  return trechos;
}

/// O título em Title Case sobre a **frase inteira**, cortado de volta nos limites dos
/// trechos — o `titleCaseSpans` de `terms.ts`. Converter trecho a trecho subiria o "do"
/// que abre um trecho no meio da frase.
List<TrechoDoTermo> _tituloEmTitleCase(List<TrechoDoTermo> trechos) {
  final convertido = titleCase(trechos.map((t) => t.texto).join());
  var inicio = 0;
  return [
    for (final t in trechos)
      TrechoDoTermo(convertido.substring(inicio, inicio += t.texto.length), negrito: t.negrito),
  ];
}

List<BlocoDoTermo> blocosDoTermo(String corpo) {
  final blocos = <BlocoDoTermo>[];
  var paragrafo = <String>[];
  var lista = <String>[];

  void fecharParagrafo() {
    if (paragrafo.isEmpty) return;
    blocos.add(BlocoDoTermo.paragrafo(_trechos(paragrafo.join(' '))));
    paragrafo = [];
  }

  void fecharLista() {
    if (lista.isEmpty) return;
    blocos.add(BlocoDoTermo.lista(lista.map(_trechos).toList()));
    lista = [];
  }

  final titulo = RegExp(r'^#{1,3}\s+(.*)$');
  final item = RegExp(r'^[-*]\s+(.*)$');

  for (final bruta in corpo.replaceAll('\r\n', '\n').split('\n')) {
    final linha = bruta.trim();

    if (linha.isEmpty) {
      fecharParagrafo();
      fecharLista();
      continue;
    }

    final t = titulo.firstMatch(linha);
    if (t != null) {
      fecharParagrafo();
      fecharLista();
      blocos.add(BlocoDoTermo.titulo(_tituloEmTitleCase(_trechos(t.group(1) ?? ''))));
      continue;
    }

    final i = item.firstMatch(linha);
    if (i != null) {
      fecharParagrafo();
      lista.add(i.group(1) ?? '');
      continue;
    }

    fecharLista();
    paragrafo.add(linha);
  }

  fecharParagrafo();
  fecharLista();
  return blocos;
}
