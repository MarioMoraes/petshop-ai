import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// O app fala com a VPS por `api.{dominio}`, e essa porta **não publica o gateway**:
/// publica uma lista de caminhos, escrita em `infra/Caddyfile`. O que estiver fora
/// dela volta 404 do Caddy sem chegar ao backend.
///
/// Este teste compara as duas listas — o que `portal_api.dart` chama e o que a borda
/// deixa passar — porque o defeito que ele previne não dá erro em lugar nenhum durante
/// o desenvolvimento: contra o backend da máquina tudo responde, e a rota nova só
/// morre depois de instalada num aparelho. É o mesmo desenho do `admin-routes.test.ts`
/// do frontend, que compara `ADMIN_ROUTE_PREFIXES` com o disco.
///
/// Quando falhar, há duas saídas, e a escolha é de segurança: ou a rota entra debaixo
/// de `/portal/v1` (o caso normal), ou ela é nomeada no `@api` do Caddyfile e aqui —
/// que foi o que aconteceu com o catálogo de estabelecimentos, anterior à escolha do
/// petshop e por isso fora do prefixo do Portal.
void main() {
  /// O que a borda publica hoje. Espelha o matcher `@api` de `infra/Caddyfile`.
  const prefixoDoPortal = '/portal/v1';
  const excecoesNomeadas = {'/public/v1/portal/tenants'};

  test('todo caminho que o app chama passa pelo recorte da borda', () {
    final fonte = File('lib/src/api/portal_api.dart').readAsStringSync();

    // Os caminhos são literais de string que começam com barra. A interpolação
    // (`/portal/v1/pets/$petId`) não atrapalha: o que se confere é o começo.
    final caminhos = RegExp(r"'(/[^']*)'")
        .allMatches(fonte)
        .map((m) => m.group(1)!)
        .toSet();

    expect(caminhos, isNotEmpty, reason: 'nenhum caminho encontrado — o regex envelheceu?');

    final foraDoRecorte = caminhos
        .where((c) => c != prefixoDoPortal && !c.startsWith('$prefixoDoPortal/'))
        .where((c) => !excecoesNomeadas.contains(c))
        .toList();

    expect(
      foraDoRecorte,
      isEmpty,
      reason: 'a borda responderia 404 a estes caminhos antes de o backend os ver — '
          'ver o matcher @api em infra/Caddyfile',
    );
  });
}
