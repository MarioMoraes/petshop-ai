/// Configuração de compilação.
///
/// Vem por `--dart-define`, com padrões que servem à máquina de quem desenvolve:
///
///   flutter run --dart-define=API_URL=http://10.0.2.2:3000
///
/// `10.0.2.2` é como o emulador do Android alcança o `localhost` da máquina — dentro do
/// emulador, `localhost` é o próprio aparelho virtual.
class Config {
  static const apiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );

  /// A chave publicável da Clerk. É pública por definição — é ela que o navegador
  /// carrega na web —, e o host da Frontend API sai dela.
  static const clerkPublishableKey = String.fromEnvironment(
    'CLERK_PUBLISHABLE_KEY',
    defaultValue: '',
  );
}
