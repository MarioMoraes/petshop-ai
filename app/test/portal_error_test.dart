import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/api/portal_error.dart';

void main() {
  test('preserva o contexto do problem+json além da frase', () {
    final erro = PortalError.deResposta(409, '''
      {"type":"https://docs.petshopai.com/errors/ERR_PORTAL_009",
       "title":"Horário indisponível","status":409,"code":"ERR_PORTAL_009",
       "detail":"Esse horário acabou de ser ocupado.","traceId":"abc",
       "alternativeStartsAt":["2026-09-22T17:00:00.000Z"]}
    ''');

    expect(erro.status, 409);
    expect(erro.code, 'ERR_PORTAL_009');
    expect(erro.message, 'Esse horário acabou de ser ocupado.');
    // Sem isto a tela diria "não deu" onde podia dizer "que tal às 14h".
    expect(erro.alternativeStartsAt, ['2026-09-22T17:00:00.000Z']);
    // A moldura não vaza para o contexto.
    expect(erro.extra.containsKey('traceId'), isFalse);
  });

  test('corpo que não é JSON ainda vira erro utilizável', () {
    final erro = PortalError.deResposta(502, '<html>bad gateway</html>');
    expect(erro.status, 502);
    expect(erro.code, 'ERR_DESCONHECIDO');
  });

  test('o estabelecimento desconhecido tem nome próprio', () {
    final erro = PortalError.deResposta(404, '{"code":"ERR_PORTAL_001","detail":"x"}');
    expect(erro.tenantDesconhecido, isTrue);
  });
}
