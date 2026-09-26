/// Title Case em português — o `titleCase` de `packages/shared-types/src/text.ts`, no
/// vocabulário do Dart. As regras são as de lá, e os casos de `test/titulo_test.dart`
/// são os mesmos de `text.test.ts`:
///
/// - só a primeira **letra** de cada palavra sobe; o resto fica como está, para "PIX" e
///   "WhatsApp" não mudarem;
/// - conectivos (de, a, e, com, para…) ficam minúsculos no meio da frase;
/// - unidades de medida ("15 kg") ficam minúsculas;
/// - um trecho recomeça depois de `·`, `—`, `–`, `:`, `?` e `!`.
///
/// A conversão não muda o tamanho do texto — só troca a caixa de letras —, e é isso que
/// deixa `blocosDoTermo` cortar o título de volta nos limites do negrito.
String titleCase(String texto) {
  var inicioDeTrecho = true;
  return texto
      .split(' ')
      .map((palavra) {
        if (palavra.isEmpty) return palavra;
        if (_quebra.hasMatch(palavra) && !_letra.hasMatch(palavra)) {
          inicioDeTrecho = true;
          return palavra;
        }
        final minuscula = palavra.toLowerCase();
        final manter =
            _unidades.contains(minuscula) ||
            (!inicioDeTrecho && _conectivos.contains(minuscula));
        inicioDeTrecho = _quebra.hasMatch(palavra);
        if (manter) return minuscula;
        final indice = palavra.indexOf(_letra);
        if (indice < 0) return palavra;
        return palavra.substring(0, indice) +
            palavra[indice].toUpperCase() +
            palavra.substring(indice + 1);
      })
      .join(' ');
}

const _conectivos = {
  'a', 'à', 'ao', 'aos', 'as', 'às', 'o', 'os', 'um', 'uma', 'uns', 'umas', //
  'de', 'da', 'das', 'do', 'dos', 'em', 'na', 'nas', 'no', 'nos', //
  'e', 'ou', 'com', 'sem', 'para', 'por', 'pelo', 'pela', 'pelos', 'pelas',
};

const _unidades = {
  'kg',
  'g',
  'mg',
  'l',
  'ml',
  'un',
  'cm',
  'm',
  'mm',
  'h',
  'min',
};

final _quebra = RegExp(r'^[·—–]$|[:?!]$');
final _letra = RegExp(r'\p{L}', unicode: true);
