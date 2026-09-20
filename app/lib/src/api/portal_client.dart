import 'dart:async';
import 'dart:convert';

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

  final String baseUrl;

  /// O petshop de que se fala. Vai em **toda** requisição, inclusive nas anônimas:
  /// sem ele o backend responde 404, porque não sabe de quem é a pergunta.
  final String slug;

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

    final cabecalhos = <String, String>{_headerSlug: slug};

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

    if (resposta.statusCode >= 400) {
      throw PortalError.deResposta(resposta.statusCode, utf8.decode(resposta.bodyBytes));
    }
    if (resposta.statusCode == 204 || resposta.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(resposta.bodyBytes));
  }

  void fechar() => _http.close();
}
