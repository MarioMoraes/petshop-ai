/// O que o app guarda entre aberturas.
///
/// São três coisas, e todas são credenciais ou chegam perto: o petshop escolhido, o
/// token de cliente da Clerk e a sessão.
///
/// É uma interface, e não uma classe só, por uma razão prática: o arnês que exercita o
/// login contra os serviços de verdade roda em `dart run`, fora do Flutter, onde um
/// plugin de plataforma não existe. Sem esta separação, provar o fluxo de entrada
/// exigiria um emulador de pé — e emulador caído viraria "não sei se funciona".
abstract class Armazenamento {
  Future<String?> get slug;
  Future<void> gravarSlug(String valor);

  Future<String?> get tokenDeCliente;
  Future<void> gravarTokenDeCliente(String valor);

  Future<String?> get sessaoId;
  Future<void> gravarSessaoId(String valor);

  /// Esquece a identidade, mas **não** o petshop.
  ///
  /// Quem sai da conta quase sempre vai entrar com outra no mesmo estabelecimento —
  /// fazê-lo digitar o endereço de novo seria castigo sem motivo.
  /// A pessoa tocou "Agora não" no cartão de avisos do Início. Guardado para o cartão
  /// não voltar a cada abertura — insistir é o que faz alguém recusar de vez.
  Future<bool> get avisosDispensados;
  Future<void> dispensarAvisos();

  Future<void> esquecerSessao();

  Future<void> esquecerTudo();
}

/// Guarda em memória. Para os testes e para o arnês de linha de comando.
class CofreEmMemoria implements Armazenamento {
  final Map<String, String> _valores = {};

  @override
  Future<String?> get slug async => _valores['slug'];
  @override
  Future<void> gravarSlug(String valor) async => _valores['slug'] = valor;

  @override
  Future<String?> get tokenDeCliente async => _valores['cliente'];
  @override
  Future<void> gravarTokenDeCliente(String valor) async => _valores['cliente'] = valor;

  @override
  Future<String?> get sessaoId async => _valores['sessao'];
  @override
  Future<void> gravarSessaoId(String valor) async => _valores['sessao'] = valor;

  @override
  Future<bool> get avisosDispensados async => _valores['avisos'] == 'dispensados';
  @override
  Future<void> dispensarAvisos() async => _valores['avisos'] = 'dispensados';

  @override
  Future<void> esquecerSessao() async {
    _valores.remove('cliente');
    _valores.remove('sessao');
  }

  @override
  Future<void> esquecerTudo() async => _valores.clear();
}
