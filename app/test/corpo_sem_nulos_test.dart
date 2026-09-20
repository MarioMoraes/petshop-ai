import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';

/// A guarda contra o defeito que o arnês de autenticação apanhou.
///
/// O `toJson` gerado escreve `"website": null` onde o app queria silêncio, e o schema
/// `.strict()` da rota responde 422. O corte de nulos conserta — e **não pode** virar
/// regra geral, porque há campos em que `null` quer dizer "apague".
void main() {
  test('tira os nulos e preserva o resto', () {
    expect(
      semNulos({'identifier': 'a@b.com', 'website': null}),
      {'identifier': 'a@b.com'},
    );
  });

  test('não confunde nulo com vazio nem com falso', () {
    expect(
      semNulos({'notes': '', 'neutered': false, 'zero': 0, 'fora': null}),
      {'notes': '', 'neutered': false, 'zero': 0},
    );
  });
}
