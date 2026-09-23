import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'armazenamento.dart';

/// A implementação de produção: o cofre do sistema.
///
/// Keychain no iOS, EncryptedSharedPreferences no Android — e não `SharedPreferences`,
/// que é texto puro legível por quem tiver acesso ao aparelho.
class CofreDoSistema implements Armazenamento {
  const CofreDoSistema([this._cofre = const FlutterSecureStorage()]);

  final FlutterSecureStorage _cofre;

  static const _slug = 'petshop.slug';
  static const _tokenCliente = 'clerk.client_token';
  static const _sessao = 'clerk.session_id';
  static const _avisos = 'avisos.dispensados';

  @override
  Future<String?> get slug => _cofre.read(key: _slug);
  @override
  Future<void> gravarSlug(String valor) => _cofre.write(key: _slug, value: valor);

  @override
  Future<String?> get tokenDeCliente => _cofre.read(key: _tokenCliente);
  @override
  Future<void> gravarTokenDeCliente(String valor) =>
      _cofre.write(key: _tokenCliente, value: valor);

  @override
  Future<String?> get sessaoId => _cofre.read(key: _sessao);
  @override
  Future<void> gravarSessaoId(String valor) => _cofre.write(key: _sessao, value: valor);

  @override
  Future<bool> get avisosDispensados async => (await _cofre.read(key: _avisos)) == '1';
  @override
  Future<void> dispensarAvisos() => _cofre.write(key: _avisos, value: '1');

  @override
  Future<void> esquecerSessao() async {
    await _cofre.delete(key: _tokenCliente);
    await _cofre.delete(key: _sessao);
  }

  @override
  Future<void> esquecerTudo() async {
    await esquecerSessao();
    await _cofre.delete(key: _slug);
  }
}

