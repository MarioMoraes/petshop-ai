import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';

void main() {
  test('deriva o host da Frontend API da chave publicável', () {
    // A chave é `pk_<ambiente>_<host em base64, com $ no fim>`.
    expect(
      ClerkFapi.hostDaChave('pk_test_bWFnaWNhbC1sZW9wYXJkLTI1ODAuY2xlcmsuYWNjb3VudHMuZGV2JA=='),
      'magical-leopard-2580.clerk.accounts.dev',
    );
  });

  test('reconhece a conta inexistente como caminho, não como falha', () {
    final erro = ClerkErro('form_identifier_not_found', 'Não achamos sua conta.');
    expect(erro.contaNaoEncontrada, isTrue);
    expect(erro.codigoInvalido, isFalse);
  });
}
