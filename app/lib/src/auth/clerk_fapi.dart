import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'armazenamento.dart';

/// Um erro vindo da Clerk, já traduzido.
class ClerkErro implements Exception {
  ClerkErro(this.codigo, this.mensagem);

  final String codigo;
  final String mensagem;

  /// Não existe conta com este e-mail — o caminho vira criar conta.
  bool get contaNaoEncontrada => codigo == 'form_identifier_not_found';

  /// Código errado ou expirado.
  bool get codigoInvalido =>
      codigo == 'form_code_incorrect' || codigo == 'verification_expired';

  /// Já existe conta com este e-mail — o caminho vira entrar.
  bool get contaJaExiste => codigo == 'form_identifier_exists';

  @override
  String toString() => 'ClerkErro($codigo): $mensagem';
}

/// O resultado de um passo que pode ou não ter terminado o login.
class PassoDeLogin {
  PassoDeLogin.precisaDeCodigo(this.tentativaId, this.destino)
      : concluido = false,
        sessaoId = null;
  PassoDeLogin.concluido(this.sessaoId)
      : concluido = true,
        tentativaId = null,
        destino = null;

  final bool concluido;

  /// O `sia_…` ou `sua_…` em curso, que o passo seguinte precisa nomear.
  final String? tentativaId;

  /// O e-mail para onde o código foi, como a Clerk o devolve.
  final String? destino;

  final String? sessaoId;
}

/// A Frontend API da Clerk, falada direto.
///
/// Não há SDK aqui de propósito: o pacote `clerk_flutter` é 0.0.x, community-maintained,
/// e a própria página diz que a Clerk não o suporta oficialmente. O que o app precisa é
/// pequeno e estável — entrar por código no e-mail, criar conta, renovar um token de 60
/// segundos e sair —, e isso cabe num arquivo que nós controlamos.
///
/// **O token de cliente rotaciona.** Toda resposta da FAPI pode trazer um `Authorization`
/// novo no cabeçalho, e usar o anterior responde `signed_out`. É o tipo de detalhe que
/// não aparece na documentação e custa uma tarde: por isso `_chamar` grava o cabeçalho a
/// cada resposta, sem exceção.
class ClerkFapi {
  ClerkFapi({
    required this.host,
    required Armazenamento armazenamento,
    http.Client? http_,
  })  : _armazenamento = armazenamento,
        _http = http_ ?? http.Client();

  /// O host da Frontend API, derivado da chave publicável.
  final String host;

  final Armazenamento _armazenamento;
  final http.Client _http;

  String? _tokenDeCliente;

  /// `_is_native=1` é o que põe a Clerk no modo de aplicativo: a sessão anda por
  /// cabeçalho em vez de cookie — e, verificado nesta instância, **dispensa o Turnstile
  /// no cadastro**, que de outro modo exigiria um desafio de navegador.
  static const _query =
      '_is_native=1&__clerk_api_version=2021-02-05&_clerk_js_version=5.0.0';

  static const _timeout = Duration(seconds: 20);

  /// Deriva o host da FAPI da chave publicável (`pk_test_<host em base64>`).
  static String hostDaChave(String publishableKey) {
    final semPrefixo = publishableKey.replaceFirst(RegExp(r'^pk_(test|live)_'), '');
    final decodificado = utf8.decode(base64.decode(base64.normalize(semPrefixo)));
    return decodificado.replaceAll(RegExp(r'\$$'), '');
  }

  Future<void> carregar() async {
    _tokenDeCliente = await _armazenamento.tokenDeCliente;
  }

  Future<Map<String, dynamic>> _chamar(
    String caminho, {
    Map<String, String> campos = const {},
  }) async {
    final uri = Uri.parse('https://$host$caminho?$_query');
    final cabecalhos = {'content-type': 'application/x-www-form-urlencoded'};
    if (_tokenDeCliente != null) cabecalhos['authorization'] = _tokenDeCliente!;

    late http.Response resposta;
    try {
      resposta = await _http.post(uri, headers: cabecalhos, body: campos).timeout(_timeout);
    } on TimeoutException {
      throw ClerkErro('timeout', 'A verificação demorou demais. Tente de novo.');
    }

    // O token de cliente rotaciona: guardar o novo é obrigatório, não otimização.
    final rotacionado = resposta.headers['authorization'];
    if (rotacionado != null && rotacionado.isNotEmpty && rotacionado != _tokenDeCliente) {
      _tokenDeCliente = rotacionado;
      await _armazenamento.gravarTokenDeCliente(rotacionado);
    }

    final json = jsonDecode(utf8.decode(resposta.bodyBytes)) as Map<String, dynamic>;
    final erros = json['errors'];
    if (erros is List && erros.isNotEmpty) {
      final primeiro = erros.first as Map<String, dynamic>;
      throw ClerkErro(
        primeiro['code'] as String? ?? 'desconhecido',
        primeiro['long_message'] as String? ??
            primeiro['message'] as String? ??
            'Não foi possível concluir.',
      );
    }
    return json;
  }

  // ── Entrar ─────────────────────────────────────────────────────────────────

  /// Pede o código para uma conta que já existe.
  ///
  /// Lança `ClerkErro.contaNaoEncontrada` quando o e-mail não tem conta — é o sinal de
  /// que a tela deve oferecer criar uma, e não uma falha a mostrar.
  Future<PassoDeLogin> entrarComEmail(String email) async {
    final criado = await _chamar('/v1/client/sign_ins', campos: {'identifier': email});
    final resposta = criado['response'] as Map<String, dynamic>;
    final id = resposta['id'] as String;

    final fatores = (resposta['supported_first_factors'] as List?) ?? const [];
    final emailCode = fatores.cast<Map<String, dynamic>>().firstWhere(
          (f) => f['strategy'] == 'email_code',
          orElse: () => throw ClerkErro(
            'sem_email_code',
            'Esta conta não aceita entrada por código no e-mail.',
          ),
        );

    await _chamar('/v1/client/sign_ins/$id/prepare_first_factor', campos: {
      'strategy': 'email_code',
      'email_address_id': emailCode['email_address_id'] as String,
    });

    return PassoDeLogin.precisaDeCodigo(
      id,
      emailCode['safe_identifier'] as String? ?? email,
    );
  }

  Future<PassoDeLogin> confirmarEntrada(String tentativaId, String codigo) async {
    final json = await _chamar(
      '/v1/client/sign_ins/$tentativaId/attempt_first_factor',
      campos: {'strategy': 'email_code', 'code': codigo},
    );
    return _concluir(json);
  }

  // ── Criar conta ────────────────────────────────────────────────────────────

  /// Cria a conta e dispara o código de verificação.
  ///
  /// A senha vai junto porque **esta instância a exige** (`password: required` no
  /// `auth_config`), mesmo que daqui em diante o tutor sempre entre por código.
  Future<PassoDeLogin> criarConta(String email, String senha) async {
    final criado = await _chamar('/v1/client/sign_ups', campos: {
      'email_address': email,
      'password': senha,
    });
    final id = (criado['response'] as Map<String, dynamic>)['id'] as String;

    await _chamar('/v1/client/sign_ups/$id/prepare_verification',
        campos: {'strategy': 'email_code'});

    return PassoDeLogin.precisaDeCodigo(id, email);
  }

  Future<PassoDeLogin> confirmarConta(String tentativaId, String codigo) async {
    final json = await _chamar(
      '/v1/client/sign_ups/$tentativaId/attempt_verification',
      campos: {'strategy': 'email_code', 'code': codigo},
    );
    return _concluir(json);
  }

  Future<PassoDeLogin> _concluir(Map<String, dynamic> json) async {
    final resposta = json['response'] as Map<String, dynamic>;
    if (resposta['status'] != 'complete') {
      throw ClerkErro(
        'incompleto',
        'Faltou um passo para concluir. Tente de novo.',
      );
    }
    final sessao = resposta['created_session_id'] as String;
    await _armazenamento.gravarSessaoId(sessao);
    return PassoDeLogin.concluido(sessao);
  }

  // ── A sessão em uso ────────────────────────────────────────────────────────

  /// Um token de sessão válido agora.
  ///
  /// Não guarda o resultado: o token da Clerk **vive 60 segundos**, e um cache aqui
  /// trocaria uma chamada barata por um 401 intermitente no meio de uma tela.
  Future<String?> tokenDeSessao(String sessaoId) async {
    try {
      final json = await _chamar('/v1/client/sessions/$sessaoId/tokens');
      return json['jwt'] as String?;
    } on ClerkErro {
      return null;
    }
  }

  Future<void> sair(String sessaoId) async {
    try {
      await _chamar('/v1/client/sessions/$sessaoId/remove');
    } on ClerkErro {
      // Sessão já encerrada do outro lado não é motivo para prender ninguém na tela.
    }
    _tokenDeCliente = null;
    await _armazenamento.esquecerSessao();
  }

  void fechar() => _http.close();
}
