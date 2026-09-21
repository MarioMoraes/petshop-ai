import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../api/portal_api.dart';
import '../api/portal_client.dart';
import '../api/portal_error.dart';
import '../config.dart';
import '../models/portal_models.dart';
import '../time/tenant_time.dart';
import 'armazenamento.dart';
import 'cofre_do_sistema.dart';
import 'clerk_fapi.dart';

/// Onde a pessoa está no caminho até ver os próprios pets.
enum EstadoDaSessao {
  carregando,

  /// Falta dizer de que petshop se fala. No app não há host que responda por isso.
  semPetshop,

  /// Há petshop, falta identidade.
  semConta,

  /// Há conta na Clerk, mas ela ainda não foi ligada à ficha que o petshop tem.
  semVinculo,

  pronta,
}

/// O estado que decide qual tela o app mostra.
///
/// A ordem não é arbitrária: **o petshop vem antes da conta**. A identidade do tutor só
/// significa alguma coisa dentro de um estabelecimento — o mesmo login pode ser cliente
/// de dois petshops, com fichas diferentes em cada um —, e a tela de entrada mostra a
/// marca de quem está sendo visitado.
class Sessao extends ChangeNotifier {
  Sessao({Armazenamento? armazenamento, ClerkFapi? clerk, http.Client? http_})
      : _armazenamento = armazenamento ?? const CofreDoSistema(),
        _http = http_ {
    _clerk = clerk ??
        ClerkFapi(
          host: ClerkFapi.hostDaChave(Config.clerkPublishableKey),
          armazenamento: _armazenamento,
        );
  }

  final Armazenamento _armazenamento;

  /// O cliente HTTP do Portal, quando alguém o entrega pronto.
  ///
  /// Existe pelo mesmo motivo que `armazenamento` e `clerk` são injetáveis: é o que
  /// permite a um teste de widget percorrer as telas de verdade — com a `Sessao`, a
  /// navegação e o `CarregarDados` reais — contra respostas conhecidas, sem emulador.
  /// Em produção fica nulo e o `PortalClient` faz o seu.
  final http.Client? _http;
  late final ClerkFapi _clerk;

  EstadoDaSessao estado = EstadoDaSessao.carregando;
  String? slug;
  PortalTenantResponse? tenant;
  PortalContextResponse? contexto;
  String? aviso;

  PortalApi? _api;
  String? _sessaoId;

  ClerkFapi get clerk => _clerk;

  /// A API do Portal, disponível assim que há petshop escolhido.
  ///
  /// Existe mesmo sem sessão porque a rota do estabelecimento é anônima — é ela que
  /// valida o slug e traz a marca antes de haver login.
  PortalApi get api {
    final atual = _api;
    if (atual == null) throw StateError('sem petshop escolhido');
    return atual;
  }

  TenantTime get tempo => TenantTime(contexto?.tenant.timezone ?? 'America/Sao_Paulo');

  /// O catálogo da primeira tela.
  ///
  /// Não passa pelo `api` porque `api` só existe depois de haver petshop escolhido — e
  /// esta é exatamente a pergunta de antes. O cliente é descartável e não leva token:
  /// ninguém está autenticado ainda.
  Future<PortalDirectoryResponse> estabelecimentos() async {
    final cliente = PortalClient.semPetshop(baseUrl: Config.apiUrl, http_: _http);
    try {
      return await PortalApi(cliente).estabelecimentos();
    } finally {
      cliente.fechar();
    }
  }

  Future<void> iniciar() async {
    await TenantTime.iniciar();
    await _clerk.carregar();
    _sessaoId = await _armazenamento.sessaoId;

    final guardado = await _armazenamento.slug;
    if (guardado == null) {
      _ir(EstadoDaSessao.semPetshop);
      return;
    }
    await escolherPetshop(guardado, gravar: false);
  }

  /// Valida o slug contra o backend e adota o estabelecimento.
  ///
  /// `GET /portal/v1/tenant` é anônimo e responde o mesmo 404 para slug inexistente,
  /// estabelecimento invisível e plano sem Portal — de propósito: quem digitou errado
  /// não tem por que descobrir se o petshop existe e deixou de pagar.
  Future<void> escolherPetshop(String novoSlug, {bool gravar = true}) async {
    final limpo = novoSlug.trim().toLowerCase();
    _api = PortalApi(PortalClient(
      baseUrl: Config.apiUrl,
      slug: limpo,
      token: _token,
      http_: _http,
    ));

    try {
      tenant = await _api!.tenant();
    } on PortalError catch (erro) {
      _api = null;
      aviso = erro.tenantDesconhecido
          ? 'Não encontramos este estabelecimento.'
          : erro.message;
      _ir(EstadoDaSessao.semPetshop);
      return;
    }

    slug = limpo;
    aviso = null;
    if (gravar) await _armazenamento.gravarSlug(limpo);
    await revalidar();
  }

  /// Pergunta ao backend em que pé está a sessão.
  ///
  /// É o mesmo `GET /portal/v1/me` que a web chama, e é ele que separa "falta entrar" de
  /// "falta vincular": token válido sem ficha ligada responde 401 `ERR_PORTAL_006` — a
  /// mesma resposta de um vínculo revogado, e para o app dá no mesmo, porque o caminho
  /// de saída dos dois é a tela de vínculo.
  Future<void> revalidar() async {
    if (_api == null) {
      _ir(EstadoDaSessao.semPetshop);
      return;
    }
    if (_sessaoId == null) {
      _ir(EstadoDaSessao.semConta);
      return;
    }

    try {
      contexto = await api.me();
      _ir(EstadoDaSessao.pronta);
    } on PortalError catch (erro) {
      contexto = null;
      if (erro.status == 401) {
        // Token que a Clerk não renova mais é sessão morta; token válido sem ficha é
        // vínculo que falta. A diferença está em conseguir ou não um token.
        final vivo = await _token() != null;
        _ir(vivo ? EstadoDaSessao.semVinculo : EstadoDaSessao.semConta);
        return;
      }
      aviso = erro.message;
      notifyListeners();
    }
  }

  Future<String?> _token() async {
    final id = _sessaoId;
    if (id == null) return null;
    return _clerk.tokenDeSessao(id);
  }

  /// Chamado pelas telas de entrada quando a Clerk conclui o login.
  Future<void> concluiuLogin(String sessaoId) async {
    _sessaoId = sessaoId;
    await revalidar();
  }

  Future<void> sair() async {
    final id = _sessaoId;
    if (id != null) await _clerk.sair(id);
    _sessaoId = null;
    contexto = null;
    _ir(EstadoDaSessao.semConta);
  }

  /// Esquece o estabelecimento — e, com ele, a sessão, que só valia lá dentro.
  Future<void> trocarPetshop() async {
    await sair();
    await _armazenamento.esquecerTudo();
    slug = null;
    tenant = null;
    _api = null;
    _ir(EstadoDaSessao.semPetshop);
  }

  void _ir(EstadoDaSessao novo) {
    estado = novo;
    notifyListeners();
  }
}
