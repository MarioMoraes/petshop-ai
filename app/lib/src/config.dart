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
  /// Clerk dizer que deu certo. Desde 2026-11-03 a VPS usa a instância Production (`pk_live_`), e é ela o padrão;
  /// contra o `pnpm dev`, passe a `pk_test_` do `.env` por `--dart-define`. Trocar de
  /// instância **exige build nova** do app — a
  /// chave está aqui dentro, não no ambiente do container.
  static const clerkPublishableKey = String.fromEnvironment(
    'CLERK_PUBLISHABLE_KEY',
    defaultValue: 'pk_live_Y2xlcmsub2ZmaWNlc3RlY25vbG9naWEuY29tLmJyJA',
  );
}
