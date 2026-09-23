import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Os avisos no aparelho (etapa 9 — push).
///
/// **Uma interface, e não o `FirebaseMessaging` direto.** O arnês de widget é o que
/// substitui o emulador neste projeto, e plugin nativo não existe no `flutter_test`: sem
/// o ponto de troca, as telas que tocam em push — o Início com o cartão, a sessão que
/// registra o aparelho — deixariam de ser alcançáveis pelo teste. Mesmo desenho de
/// `arquivos.dart` e do `http_` injetado na `Sessao`.
///
/// **E o real nunca lança.** Antes de o projeto do Firebase existir, sem o
/// `google-services.json`, o `Firebase.initializeApp` falha — e o app tem de continuar
/// funcionando igual, só sem aviso. Por isso toda chamada ao SDK passa por uma guarda que
/// converte a falha em "indisponível".
abstract class Avisos {
  /// Liga o SDK. `false` quando não há Firebase configurado: o resto vira silêncio.
  Future<bool> iniciar();

  Future<PermissaoDeAvisos> permissao();

  /// Mostra o pedido do sistema. Só a partir de um toque da pessoa — ver o Início.
  Future<PermissaoDeAvisos> pedir();

  Future<String?> token();

  Stream<String> get tokensNovos;

  /// O aviso tocado com o app em segundo plano.
  Stream<AvisoTocado> get tocados;

  /// O aviso que **abriu** o app, quando ele estava fechado.
  Future<AvisoTocado?> inicial();

  /// O aviso que chega com o app aberto: o Android não o desenha, e a tela diz.
  Stream<AvisoTocado> get emPrimeiroPlano;

  String get plataforma;
}

enum PermissaoDeAvisos {
  /// O Firebase não está configurado neste build.
  indisponivel,

  /// A pessoa ainda não respondeu ao pedido do sistema.
  naoDecidida,
  concedida,
  negada,
}

/// O que o backend manda em `data`, já lido.
class AvisoTocado {
  const AvisoTocado({
    required this.slug,
    required this.abre,
    this.titulo,
    this.appointmentId,
  });

  final String? slug;

  /// `agendamento` ou `conta` — o `push.abre` do template no backend.
  final String abre;
  final String? titulo;
  final String? appointmentId;

  static AvisoTocado deMensagem(RemoteMessage mensagem) => AvisoTocado(
        slug: mensagem.data['slug'] as String?,
        abre: (mensagem.data['abre'] as String?) ?? 'agendamento',
        titulo: mensagem.notification?.title,
        appointmentId: mensagem.data['appointmentId'] as String?,
      );
}

/// O ponto de troca. Os testes o substituem; o app usa o Firebase.
Avisos avisos = AvisosDoFirebase();

class AvisosDoFirebase implements Avisos {
  bool _ligado = false;

  FirebaseMessaging get _fcm => FirebaseMessaging.instance;

  @override
  Future<bool> iniciar() async {
    if (_ligado) return true;
    try {
      await Firebase.initializeApp();
      _ligado = true;
    } catch (erro) {
      debugPrint('avisos: Firebase indisponível ($erro) — o app segue sem push');
    }
    return _ligado;
  }

  @override
  Future<PermissaoDeAvisos> permissao() async {
    if (!_ligado) return PermissaoDeAvisos.indisponivel;
    try {
      return _traduzir((await _fcm.getNotificationSettings()).authorizationStatus);
    } catch (_) {
      return PermissaoDeAvisos.indisponivel;
    }
  }

  @override
  Future<PermissaoDeAvisos> pedir() async {
    if (!_ligado) return PermissaoDeAvisos.indisponivel;
    try {
      return _traduzir((await _fcm.requestPermission()).authorizationStatus);
    } catch (_) {
      return PermissaoDeAvisos.indisponivel;
    }
  }

  static PermissaoDeAvisos _traduzir(AuthorizationStatus status) => switch (status) {
        AuthorizationStatus.authorized ||
        AuthorizationStatus.provisional =>
          PermissaoDeAvisos.concedida,
        AuthorizationStatus.denied ||
        AuthorizationStatus.deniedPermanently =>
          PermissaoDeAvisos.negada,
        AuthorizationStatus.notDetermined => PermissaoDeAvisos.naoDecidida,
      };

  @override
  Future<String?> token() async {
    if (!_ligado) return null;
    try {
      return await _fcm.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get tokensNovos =>
      _ligado ? _fcm.onTokenRefresh : const Stream<String>.empty();

  @override
  Stream<AvisoTocado> get tocados => _ligado
      ? FirebaseMessaging.onMessageOpenedApp.map(AvisoTocado.deMensagem)
      : const Stream<AvisoTocado>.empty();

  @override
  Future<AvisoTocado?> inicial() async {
    if (!_ligado) return null;
    try {
      final mensagem = await _fcm.getInitialMessage();
      return mensagem == null ? null : AvisoTocado.deMensagem(mensagem);
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<AvisoTocado> get emPrimeiroPlano => _ligado
      ? FirebaseMessaging.onMessage.map(AvisoTocado.deMensagem)
      : const Stream<AvisoTocado>.empty();

  @override
  String get plataforma => Platform.isIOS ? 'IOS' : 'ANDROID';
}
