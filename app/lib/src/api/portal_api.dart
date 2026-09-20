import '../models/portal_models.dart';
import 'portal_client.dart';

/// As chamadas do Portal que o MVP usa, com os tipos que o backend define.
///
/// A tradução de `frontend/src/lib/portal-api.ts`, cortada no escopo do app. Cada
/// caminho e cada parâmetro foi verificado contra o backend em execução — os schemas
/// das rotas são `.strict()`, então **parâmetro desconhecido é 422**, e não algo que o
/// servidor ignora de bom grado.
class PortalApi {
  PortalApi(this._cliente);

  final PortalClient _cliente;

  // ── Antes da sessão ────────────────────────────────────────────────────────

  /// A identidade visual do petshop, sem sessão nenhuma.
  ///
  /// É também o que valida o slug que a pessoa digitou: estabelecimento inexistente,
  /// invisível ou em plano sem Portal respondem o mesmo `ERR_PORTAL_001`.
  Future<PortalTenantResponse> tenant() async =>
      PortalTenantResponse.fromJson(await _cliente.get('/portal/v1/tenant', anonimo: true));

  // ── Vínculo da ficha ───────────────────────────────────────────────────────

  /// Pede o código que liga esta conta à ficha que o petshop já tem.
  Future<PortalChallengeResponse> pedirCodigo(PortalChallenge entrada) async =>
      PortalChallengeResponse.fromJson(
        await _cliente.post('/portal/v1/access/challenge', corpo: entrada.toJson()),
      );

  /// Confere o código e conclui o vínculo.
  Future<void> confirmarCodigo(PortalVerify entrada) =>
      _cliente.post('/portal/v1/access/verify', corpo: entrada.toJson());

  // ── A sessão ───────────────────────────────────────────────────────────────

  /// Quem é o tutor aqui, e o que este estabelecimento tem ligado.
  ///
  /// `features` é o que a navegação lê para decidir o que mostrar — agendamento online
  /// e leva-e-traz dependem do plano e da configuração, e o app degrada sozinho em vez
  /// de oferecer uma tela que responderia 402.
  Future<PortalContextResponse> me() async =>
      PortalContextResponse.fromJson(await _cliente.get('/portal/v1/me'));

  // ── Pets ───────────────────────────────────────────────────────────────────

  Future<List<PortalPetSummary>> pets() async {
    final json = await _cliente.get('/portal/v1/pets');
    return (json['pets'] as List).map((p) => PortalPetSummary.fromJson(p)).toList();
  }

  Future<PortalPetDetail> pet(String petId) async =>
      PortalPetDetail.fromJson(await _cliente.get('/portal/v1/pets/$petId'));

  /// O histórico do pet, paginado por cursor.
  Future<PortalTimelineResponse> timeline(String petId, {String? cursor}) async =>
      PortalTimelineResponse.fromJson(
        await _cliente.get(
          '/portal/v1/pets/$petId/timeline',
          query: {'cursor': ?cursor},
        ),
      );

  // ── Agendar ────────────────────────────────────────────────────────────────

  /// Os serviços que **este pet** pode receber — a lista depende do porte e da espécie.
  Future<PortalBookingServicesResponse> servicos(String petId) async =>
      PortalBookingServicesResponse.fromJson(
        await _cliente.get('/portal/v1/booking/services', query: {'petId': petId}),
      );

  /// A grade de um dia.
  ///
  /// `dia` é `YYYY-MM-DD` no fuso do petshop, e não um instante: quem escolhe é o dia.
  /// `serviceIds` vai separado por vírgula, como a rota do domínio que responde por
  /// baixo — o BFF repassa a pergunta em vez de recalcular a grade, e é isso que garante
  /// que o tutor veja os mesmos horários que a recepção veria.
  Future<PortalAvailabilityResponse> disponibilidade({
    required String petId,
    required List<String> serviceIds,
    required String dia,
  }) async =>
      PortalAvailabilityResponse.fromJson(
        await _cliente.get('/portal/v1/booking/availability', query: {
          'petId': petId,
          'serviceIds': serviceIds.join(','),
          'date': dia,
        }),
      );

  /// O leva-e-traz disponível para este pet, se o plano o tiver.
  Future<PortalTaxiOffer> ofertaDeTaxi(String petId) async =>
      PortalTaxiOffer.fromJson(
        await _cliente.get('/portal/v1/booking/taxi', query: {'petId': petId}),
      );

  Future<PortalAppointmentDetail> agendar(PortalBooking pedido) async =>
      PortalAppointmentDetail.fromJson(
        await _cliente.post('/portal/v1/booking', corpo: pedido.toJson()),
      );

  // ── Agendamentos ───────────────────────────────────────────────────────────

  Future<PortalAppointmentsResponse> agendamentos({String? cursor, int? limite}) async =>
      PortalAppointmentsResponse.fromJson(
        await _cliente.get('/portal/v1/appointments', query: {
          'cursor': ?cursor,
          if (limite != null) 'limit': '$limite',
        }),
      );

  Future<PortalAppointmentDetail> agendamento(String id) async =>
      PortalAppointmentDetail.fromJson(await _cliente.get('/portal/v1/appointments/$id'));

  /// Cancela.
  ///
  /// Fora da janela, a **primeira** tentativa é recusada dizendo quanto custa, e só a
  /// segunda — com `acknowledgeFee` — passa. A consequência é mostrada antes, e quem
  /// confirma é a pessoa, não a tela.
  Future<void> cancelar(String id, {bool aceitarTaxa = false}) => _cliente.post(
        '/portal/v1/appointments/$id/cancel',
        corpo: PortalCancel(acknowledgeFee: aceitarTaxa).toJson(),
      );

  Future<PortalAppointmentDetail> remarcar(String id, PortalReschedule destino) async =>
      PortalAppointmentDetail.fromJson(
        await _cliente.post('/portal/v1/appointments/$id/reschedule', corpo: destino.toJson()),
      );
}
