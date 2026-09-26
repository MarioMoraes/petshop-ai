import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/titulo.dart';

/// Os mesmos casos de `packages/shared-types/src/text.test.ts`: as duas funções são a
/// mesma regra, e divergir seria o termo sair num caixa no app e noutro no PDF.
void main() {
  const casos = {
    'Contas a receber': 'Contas a Receber',
    'Pagamento de tutor · Maria da Silva':
        'Pagamento de Tutor · Maria da Silva',
    'O caixa está fechado': 'O Caixa Está Fechado',
    'Venda avulsa · ração 15 kg ×2': 'Venda Avulsa · Ração 15 kg ×2',
    'Pagamento via PIX no WhatsApp': 'Pagamento Via PIX no WhatsApp',
    'Onde você quer entrar?': 'Onde Você Quer Entrar?',
    'Tudo certo, bem-vindo!': 'Tudo Certo, Bem-vindo!',
    'Registro feito por engano?': 'Registro Feito por Engano?',
    'Excluir: a ficha do pet': 'Excluir: A Ficha do Pet',
    'Telefone (opcional)': 'Telefone (Opcional)',
    'E-mail e senha': 'E-mail e Senha',
    '': '',
  };

  casos.forEach((entrada, saida) {
    test('"$entrada" → "$saida"', () => expect(titleCase(entrada), saida));
  });

  test('é idempotente', () {
    final uma = titleCase('Contas recebidas por dia');
    expect(titleCase(uma), uma);
  });
}
