import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'portal_error.dart';

/// Tira do corpo os campos nulos.
///
/// Os modelos são gerados, e um `toJson` gerado não distingue "ausente" de "nulo":
/// escreve `"website": null` onde o app queria não dizer nada. Os schemas das rotas são
/// `.strict()`, e um campo `.optional()` recusa `null` com 422 — o erro é
/// `expected string, received null`, e ele não aponta para o gerador.
///
/// **Não é para aplicar em tudo.** Em `UpdateOwnPetSchema`, `birthDate`, `neutered` e
/// `notes` são `.nullable()` *e* `.optional()` ao mesmo tempo: ali `null` quer dizer
/// **apague este valor** e ausente quer dizer **não mexa**. Cortar nulos por atacado
/// transformaria "apagar a data de nascimento" num silêncio — o pior tipo de defeito,
/// o que não dá erro. Por isso quem chama decide, caso a caso.
Map<String, dynamic> semNulos(Map<String, dynamic> corpo) => {
      for (final entrada in corpo.entries)
        if (entrada.value != null) entrada.key: entrada.value,
    };

/// Quem sabe entregar um token de sessão válido.
///
/// O token do Clerk **vive 60 segundos** — medido, não estimado. Por isso o contrato
/// aqui não é "me dê o token que você guardou", é "me dê um token válido agora": quem
/// implementa decide se renova, e o cliente HTTP não precisa saber.
typedef TokenDeSessao = Future<String?> Function();

/// O cliente do Portal do Tutor.
///
/// Espelha `frontend/src/lib/portal-api.ts`, com uma diferença que não é de estilo: na
/// web o slug sai do host que o Next serviu, e aqui ele é **configuração do app** — um
/// aparelho não tem host. O resto do acordo é o mesmo, e é o que o backend espera.
class PortalClient {
  PortalClient({
    required this.baseUrl,
    required this.slug,
    required this.token,
    http.Client? http_,
  }) : _http = http_ ?? http.Client();

  /// O cliente de quem ainda **não escolheu** petshop.
  ///
  /// Serve a uma rota só, o catálogo da primeira tela: ela é anterior à escolha, então
  /// não há slug a mandar. Nasce por um construtor próprio, e não por um parâmetro
  /// opcional, para que o slug continue obrigatório em todo o resto — a exceção é
  /// declarada, e não um esquecimento possível.
  PortalClient.semPetshop({required this.baseUrl, http.Client? http_})
      : slug = null,
        token = _semToken,
        _http = http_ ?? http.Client();

  static Future<String?> _semToken() async => null;

  final String baseUrl;

  /// O petshop de que se fala. Vai em **toda** requisição, inclusive nas anônimas:
  /// sem ele o backend responde 404, porque não sabe de quem é a pergunta.
  ///
  /// Nulo só no cliente do catálogo, que é a única pergunta anterior à escolha.
  final String? slug;

  final TokenDeSessao token;
  final http.Client _http;

  static const _headerSlug = 'x-petshop-tenant-slug';

  /// Teto por requisição.
  ///
  /// Um `await` que nunca volta deixa a tela girando para sempre, sem erro e sem nada a
  /// investigar. Quinze segundos é o mesmo teto do cliente da web.
  static const _timeout = Duration(seconds: 15);

  Future<dynamic> get(String caminho, {Map<String, String>? query, bool anonimo = false}) =>
      _enviar('GET', caminho, query: query, anonimo: anonimo);

  Future<dynamic> post(String caminho, {Object? corpo, bool anonimo = false}) =>
      _enviar('POST', caminho, corpo: corpo, anonimo: anonimo);

  Future<dynamic> patch(String caminho, {Object? corpo}) =>
      _enviar('PATCH', caminho, corpo: corpo);

  /// Um GET cuja resposta **não é JSON**: o extrato em PDF do MOD-DOC-09.
  ///
  /// Existe como método próprio, e não como um parâmetro do `_enviar`, porque o que
  /// muda é o contrato inteiro da volta — bytes em vez de mapa, e um nome de arquivo
  /// que só o servidor sabe. O que ele **não** muda é o tratamento do erro: um 403 ou
  /// um 404 aqui continua chegando como `problem+json`, e é o mesmo `PortalError` que
  /// a tela já sabe ler.
  ///
  /// O extrato desce em bytes, e não como URL assinada como o recibo, porque ele não é
  /// arquivado (AC-04 de MOD-DOC-09): não existe endereço a assinar, o PDF nasce na
  /// requisição e morre com ela.
  Future<ArquivoDoPortal> arquivo(String caminho, {required String nomePadrao}) async {
    final resposta = await _responder('GET', Uri.parse('$baseUrl$caminho'));

    return ArquivoDoPortal(
      bytes: resposta.bodyBytes,
      // O `content-disposition` do backend traz o nome com a data dentro
      // (`extrato-2026-09.pdf`), e é ele que a folha de compartilhamento mostra. Quando
      // um intermediário o come, o padrão de quem chamou serve — arquivo sem nome chega
      // ao e-mail como `documento` e não se acha depois.
      nome: _nomeDoArquivo(resposta.headers['content-disposition']) ?? nomePadrao,
    );
  }

  /// `attachment; filename="extrato-2026-09.pdf"` → `extrato-2026-09.pdf`.
  static String? _nomeDoArquivo(String? disposicao) {
    if (disposicao == null) return null;
    final casamento = RegExp('filename="?([^";]+)"?').firstMatch(disposicao);
    final nome = casamento?.group(1)?.trim();
    return (nome == null || nome.isEmpty) ? null : nome;
  }

  Future<dynamic> _enviar(
    String metodo,
    String caminho, {
    Map<String, String>? query,
    Object? corpo,
    bool anonimo = false,
  }) async {
    final uri = Uri.parse('$baseUrl$caminho').replace(
      queryParameters: (query == null || query.isEmpty) ? null : query,
    );

    final resposta = await _responder(metodo, uri, corpo: corpo, anonimo: anonimo);

    if (resposta.statusCode == 204 || resposta.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(resposta.bodyBytes));
  }

  /// A requisição em si: os cabeçalhos, o teto de tempo e a tradução do erro.
  ///
  /// Tudo o que os dois caminhos — o JSON e o arquivo — têm em comum mora aqui, para
  /// que o download não nasça sem `authorization`, sem slug ou sem `timeout`. Ele
  /// devolve a resposta crua: quem chamou decide se a lê como mapa ou como bytes.
  Future<http.Response> _responder(
    String metodo,
    Uri uri, {
    Object? corpo,
    bool anonimo = false,
  }) async {
    final cabecalhos = <String, String>{_headerSlug: ?slug};

    // `content-type` **só quando há corpo**: anunciar JSON e não mandar nada faz o
    // Fastify recusar a requisição antes de chegar em rota nenhuma — e POST sem corpo é
    // o formato certo de uma ação que não carrega dado, como o aceite de um termo.
    if (corpo != null) cabecalhos['content-type'] = 'application/json';

    if (!anonimo) {
      final jwt = await token();
      if (jwt != null) cabecalhos['authorization'] = 'Bearer $jwt';
    }

    final requisicao = http.Request(metodo, uri)..headers.addAll(cabecalhos);
    if (corpo != null) requisicao.body = jsonEncode(corpo);

    late http.Response resposta;
    try {
      final fluxo = await _http.send(requisicao).timeout(_timeout);
      resposta = await http.Response.fromStream(fluxo);
    } on TimeoutException {
      throw PortalError(
        status: 504,
        code: 'ERR_TIMEOUT',
        message: 'O servidor demorou demais para responder.',
      );
    }

    // `allowMalformed` porque nem todo corpo de erro é nosso: um 502 do proxy chega
    // como página HTML em outra codificação, e aí o `utf8.decode` estrito lança
    // `FormatException` **por fora** do `PortalError` — a tela perde o status e o
    // código, e diz "verifique a conexão" para um servidor que respondeu.
    if (resposta.statusCode >= 400) {
      throw PortalError.deResposta(
        resposta.statusCode,
        utf8.decode(resposta.bodyBytes, allowMalformed: true),
      );
    }

    return resposta;
  }

  void fechar() => _http.close();
}

/// Um documento que veio do Portal: os bytes e o nome com que ele deve ser gravado.
class ArquivoDoPortal {
  const ArquivoDoPortal({required this.bytes, required this.nome});

  final Uint8List bytes;
  final String nome;
}
