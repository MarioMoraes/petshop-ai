/// Configuração de compilação.
///
/// Os padrões são os de **produção**: `flutter run` sem argumento nenhum, e
/// `flutter build apk` sem argumento nenhum, já falam com a VPS. É o que faz o app
/// instalado num aparelho qualquer funcionar em rede qualquer — o pedido que trouxe
/// estes valores para cá.
///
/// Para falar com o backend da sua máquina:
///
///   flutter run --dart-define-from-file=dart_defines/local.json
///
/// O arquivo só nomeia `API_URL`; o que ele não diz mantém o padrão daqui.
class Config {
  /// Onde o Portal atende.
  ///
  /// `api.{dominio}` publica **só** o Portal — `/portal/v1` e o catálogo de
  /// estabelecimentos —, e o recorte é da borda, em `infra/Caddyfile`. O `/v1` do
  /// Admin não tem endereço na internet, e um caminho fora do recorte volta 404 do
  /// Caddy sem chegar ao backend.
  static const apiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'https://api.petshop.officestecnologia.com.br',
  );

  /// A chave publicável da Clerk. É pública por definição — é ela que o navegador
  /// carrega na web e ela vai assada no APK de qualquer jeito —, e o host da Frontend
  /// API sai dela.
  ///
  /// **Tem de ser a mesma instância do backend**, ou todo login vira 401 depois de a
  /// Clerk dizer que deu certo. Hoje a VPS e o `pnpm dev` compartilham esta:
  /// `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` no `.env` e no `.env.production`. No dia em
  /// que a produção passar para uma `pk_live_`, **o app precisa de build nova** — a
  /// chave está aqui dentro, não no ambiente do container.
  static const clerkPublishableKey = String.fromEnvironment(
    'CLERK_PUBLISHABLE_KEY',
    defaultValue: 'pk_test_bWFnaWNhbC1sZW9wYXJkLTI1ODAuY2xlcmsuYWNjb3VudHMuZGV2JA',
  );
}
