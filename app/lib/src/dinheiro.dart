import 'package:intl/intl.dart';

/// `9000` → `R$ 90,00`.
///
/// O servidor manda **centavos inteiros** em toda parte, e o app nunca divide por 100 na
/// tela: dinheiro em `double` acumula erro de arredondamento, e o primeiro lugar onde
/// isso aparece é a soma de três serviços que não fecha com a conta do balcão.
///
/// É o `formatBRL` de `packages/shared-types/src/money.ts`, no vocabulário do Dart — e o
/// locale é fixo `pt_BR` pela mesma razão que o fuso é o do petshop: o preço é em reais
/// para quem está em São Paulo e para quem está em Lisboa.
/// O separador entre o `R$` e o número é um **espaço inquebrável** (U+00A0), como o
/// `pt_BR` do ICU o define. Não é detalhe de formatação: numa lista de preços que
/// quebra linha, o espaço comum deixaria o `R$` sozinho no fim de uma linha e o valor
/// no começo da outra. Quem escrever teste contra este texto precisa do `\u00A0`.
String reais(int centavos) =>
    NumberFormat.currency(locale: 'pt_BR', symbol: 'R\$').format(centavos / 100);
