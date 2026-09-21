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

/// Quanto o tutor **deve**, em centavos. Zero para quem está em dia ou tem crédito.
///
/// `portalOwesCents` de `packages/shared-types/src/portal.ts`, no vocabulário do Dart.
///
/// A convenção da plataforma é **negativo para dívida** (RN-02 do MOD-LEDGER, e a mesma
/// de `tutors.balance_cents`), e ela é contraintuitiva para quem monta tela: a tentação
/// é ler "saldo maior que zero" como "deve". Já aconteceu — o início do Portal na web
/// dizia "Sem pendências" a quem devia e "Em aberto" a quem tinha crédito, e passou por
/// typecheck, lint e suíte. Estas duas funções existem para que nenhuma tela do app
/// refaça a conta.
int deveEmCentavos(int saldoEmCentavos) =>
    saldoEmCentavos < 0 ? -saldoEmCentavos : 0;

/// Quanto o tutor tem de **crédito**, em centavos. Zero para quem deve.
int creditoEmCentavos(int saldoEmCentavos) =>
    saldoEmCentavos > 0 ? saldoEmCentavos : 0;
