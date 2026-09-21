import '../models/portal_models.dart';
import 'agendamento_criado.dart';
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

  /// O catálogo de estabelecimentos, para a primeira tela.
  ///
  /// **A única rota do app que não fala de um petshop em particular** — é a pergunta de
  /// quem ainda não escolheu —, e por isso a única fora de `/portal/v1`: todo caminho
  /// daquele prefixo tem o tenant resolvido antes do roteamento, a partir do header do
  /// slug que aqui ainda não existe.
  ///
  /// O que desce é o que está na fachada, e só de quem ligou o Portal do cliente final:
  /// o critério é o mesmo que `tenant()` aplica, então nada daqui abre num 404.
  Future<PortalDirectoryResponse> estabelecimentos() async =>
      PortalDirectoryResponse.fromJson(
        await _cliente.get('/public/v1/portal/tenants', anonimo: true),
      );

  /// A identidade visual do petshop, sem sessão nenhuma.
  ///
  /// É também o que valida o slug que a pessoa digitou: estabelecimento inexistente,
  /// invisível ou em plano sem Portal respondem o mesmo `ERR_PORTAL_001`.
  Future<PortalTenantResponse> tenant() async =>
      PortalTenantResponse.fromJson(await _cliente.get('/portal/v1/tenant', anonimo: true));

  // ── Vínculo da ficha ───────────────────────────────────────────────────────

  /// Pede o código que liga esta conta à ficha que o petshop já tem.
  /// `semNulos` porque `website` é `.optional()` no schema, e não `.nullable()`: o
  /// honeypot da web não existe no app, e mandá-lo como `null` é 422.
  Future<PortalChallengeResponse> pedirCodigo(PortalChallenge entrada) async =>
      PortalChallengeResponse.fromJson(
        await _cliente.post('/portal/v1/access/challenge',
            corpo: semNulos(entrada.toJson())),
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
  Future<PortalTimelineResponse> timeline(String petId, {String? cursor, int? limite}) async =>
      PortalTimelineResponse.fromJson(
        await _cliente.get(
          '/portal/v1/pets/$petId/timeline',
          query: {
            'cursor': ?cursor,
            if (limite != null) 'limit': '$limite',
          },
        ),
      );

  /// A parte da ficha que o tutor pode corrigir: nome, nascimento, castração e
  /// observações. Devolve a ficha **recarregada** — a idade e os alertas não saem de um
  /// `update`, e a tela que acabou de salvar precisa deles.
  ///
  /// **Esta é a chamada em que `semNulos` seria um defeito.** No `UpdateOwnPetSchema`,
  /// `birthDate`, `neutered` e `notes` são `.nullable()` *e* `.optional()`: `null` quer
  /// dizer **apague** e ausente quer dizer **não mexa**. Quem limpou a data de
  /// nascimento pediu para voltar ao "não sei", e cortar o `null` do corpo transformaria
  /// esse pedido em silêncio — o formulário fecharia dizendo que salvou, com o valor
  /// antigo intacto. Peso, porte, raça e pelagem não estão aqui porque não estão no
  /// schema: a trava é o contrato, e o 422 nasce antes do handler.
  Future<PortalPetDetail> atualizarPet(String petId, UpdateOwnPet mudanca) async =>
      PortalPetDetail.fromJson(
        await _cliente.patch('/portal/v1/pets/$petId', corpo: mudanca.toJson()),
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

  /// Marca o horário.
  ///
  /// `semNulos` porque `notes` e `taxi` são `.optional()`: um pedido sem observação nem
  /// leva-e-traz não deve dizer `null` — deve não dizer nada.
  ///
  /// **A resposta não é `PortalAppointmentDetail`**, ainda que se pareça: é
  /// `AgendamentoCriado`, a única classe escrita à mão do app, porque esta rota não tem
  /// schema Zod. A confusão durou da fatia 1 até `tool/smoke_booking.dart` marcar um
  /// horário de verdade e o `actions` ausente derrubar o `fromJson`.
  Future<AgendamentoCriado> agendar(PortalBooking pedido) async =>
      AgendamentoCriado.fromJson(
        await _cliente.post('/portal/v1/booking', corpo: semNulos(pedido.toJson())),
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

  /// Cancela, e devolve o agendamento já cancelado.
  ///
  /// Fora da janela, a **primeira** tentativa é recusada com `ERR_PORTAL_011` dizendo
  /// quanto custa, e só a segunda — com `acknowledgeFee` — passa. A consequência é
  /// mostrada antes, e quem confirma é a pessoa, não a tela. A tela pode estar velha; a
  /// regra não, e é por isso que o servidor recusa mesmo quando o botão já avisou.
  Future<PortalAppointmentDetail> cancelar(String id, {bool aceitarTaxa = false}) async =>
      PortalAppointmentDetail.fromJson(
        await _cliente.post(
          '/portal/v1/appointments/$id/cancel',
          corpo: PortalCancel(acknowledgeFee: aceitarTaxa).toJson(),
        ),
      );

  /// Remarca. Devolve o agendamento **novo** — o anterior vira histórico no instante
  /// da resposta, e é para o novo que a tela olha.
  Future<PortalAppointmentDetail> remarcar(String id, PortalReschedule destino) async =>
      PortalAppointmentDetail.fromJson(
        await _cliente.post('/portal/v1/appointments/$id/reschedule', corpo: destino.toJson()),
      );
}
