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

  /// A oferta de leva-e-traz: dá para buscar aqui, e quanto custa cada perna.
  ///
  /// **Não recebe pet**, ainda que a rota viva sob `/booking`: o preço sai do CEP do
  /// endereço primário do **tutor**, e o handler resolve o `tutorId` por
  /// `requireOwnScope`. A primeira versão mandava `?petId=`, que o servidor ignorava em
  /// silêncio — e um parâmetro ignorado é o que faz a tela acreditar numa dependência
  /// que não existe, e repetir a pergunta a cada troca de pet.
  ///
  /// Um POST que criasse a corrida para descobrir o preço deixaria lixo no painel do
  /// petshop a cada pergunta do tutor; é para isso que esta rota existe.
  Future<PortalTaxiOffer> ofertaDeTaxi() async =>
      PortalTaxiOffer.fromJson(await _cliente.get('/portal/v1/booking/taxi'));

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

  // ── Financeiro ─────────────────────────────────────────────────────────────

  /// O painel da conta: saldo, pacotes com crédito e como pagar (MOD-PORTAL-08).
  ///
  /// `balanceCents` é **negativo para dívida** — a convenção da plataforma, e a mesma de
  /// `tutors.balance_cents`. Nenhuma tela refaz essa leitura à mão: `deveEmCentavos` e
  /// `creditoEmCentavos`, em `dinheiro.dart`, são a tradução das duas funções que
  /// `shared-types/portal.ts` criou depois de o Portal da web ter dito "Sem pendências"
  /// a quem devia.
  Future<PortalFinanceResponse> financeiro() async =>
      PortalFinanceResponse.fromJson(await _cliente.get('/portal/v1/finance'));

  /// O extrato, paginado **por página** e não por cursor.
  ///
  /// É a única lista do app assim, e a razão está no dado: o extrato ordena por
  /// `occurred_at`, que repete — três serviços do mesmo dia entram no mesmo instante —,
  /// e um cursor por data pularia ou repetiria linhas. A resposta traz o `total`, que é
  /// como a tela sabe quando parar de oferecer "Ver mais".
  Future<PortalStatementResponse> extrato({int? pagina, int? limite}) async =>
      PortalStatementResponse.fromJson(
        await _cliente.get('/portal/v1/finance/statement', query: {
          if (pagina != null) 'page': '$pagina',
          if (limite != null) 'limit': '$limite',
        }),
      );

  /// O mesmo extrato em papel (AC-02 de MOD-DOC-09).
  ///
  /// Bytes, e não uma URL: o extrato não é arquivado, então não há endereço a assinar.
  /// O nome de reserva tem a data para o caso de o `content-disposition` não chegar —
  /// dois extratos baixados no mesmo aparelho precisam de nomes diferentes.
  Future<ArquivoDoPortal> extratoEmPdf(DateTime hoje) => _cliente.arquivo(
        '/portal/v1/finance/statement/pdf',
        nomePadrao: 'extrato-${hoje.toIso8601String().substring(0, 10)}.pdf',
      );

  /// O recibo de um pagamento (AC-03 de MOD-PORTAL-08).
  ///
  /// `url` **pode voltar nula**, e isso não é erro: o PDF nasce depois do pagamento,
  /// fora da transação, e um recibo ainda em preparo tem número e não tem arquivo. A
  /// tela diz "em preparo" em vez de abrir um endereço morto.
  ///
  /// 404 aqui é pagamento que não é deste tutor (RN-03), e a tela **não** o distingue de
  /// uma falha: dizer "não é seu" a quem adivinhou um id confirmaria que ele existe.
  Future<PortalReceiptResponse> recibo(String paymentId) async =>
      PortalReceiptResponse.fromJson(
        await _cliente.get('/portal/v1/finance/receipts/$paymentId'),
      );

  // ── Meus Dados ─────────────────────────────────────────────────────────────
  //
  // **Toda escrita desta seção devolve a ficha inteira relida**, e não o recurso que
  // mudou: a tela é uma só, e é a resposta do servidor que passa a valer — a tela nunca
  // remenda o que tinha com o que supôs ter salvado.

  /// A ficha como o titular a vê (MOD-PORTAL-09). Sem `notes`: aquilo é o caderno da
  /// recepção, e só desce na exportação.
  Future<PortalMeDataResponse> meusDados() async =>
      PortalMeDataResponse.fromJson(await _cliente.get('/portal/v1/me/data'));

  /// Nome social e nascimento — os dois campos que o tutor muda sozinho.
  ///
  /// **Sem `semNulos`, pela mesma razão do `atualizarPet`:** no `UpdateOwnTutorSchema`
  /// os dois são `.nullable()`, e `null` é o "apague" de quem limpou o campo. O
  /// formulário manda os dois sempre. Nome civil, CPF e contato ficam fora porque o
  /// schema é `.strict()` — mandá-los seria 422.
  Future<PortalMeDataResponse> atualizarPerfil(UpdateOwnTutor mudanca) async =>
      PortalMeDataResponse.fromJson(
        await _cliente.patch('/portal/v1/me/data', corpo: mudanca.toJson()),
      );

  /// Endereço novo. `semNulos` porque `complement` e `accessNotes` são `.optional()`, e
  /// não `.nullable()`: aqui `null` é 422.
  Future<PortalMeDataResponse> adicionarEndereco(PortalAddressInput endereco) async =>
      PortalMeDataResponse.fromJson(
        await _cliente.post('/portal/v1/me/addresses', corpo: semNulos(endereco.toJson())),
      );

  /// Corrige um endereço.
  ///
  /// Também `semNulos`, e o jeito de **apagar** o complemento é string vazia, não
  /// `null`: o serviço de endereços grava `null` quando recebe `""`. Quem monta o
  /// pedido é o formulário, que sabe a diferença entre "não mexi" e "limpei".
  Future<PortalMeDataResponse> corrigirEndereco(
    String enderecoId,
    UpdatePortalAddress mudanca,
  ) async =>
      PortalMeDataResponse.fromJson(
        await _cliente.patch(
          '/portal/v1/me/addresses/$enderecoId',
          corpo: semNulos(mudanca.toJson()),
        ),
      );

  /// Pede o código que confirma um telefone ou e-mail novo (AC-02).
  ///
  /// O código sai para o contato **novo** — é a posse dele que se prova. Pedir de novo
  /// invalida o pedido anterior no servidor, e é por isso que a tela deixa voltar e
  /// corrigir o número digitado mesmo com um desafio aberto.
  Future<PortalContactChangeResponse> pedirTrocaDeContato(PortalContactChange troca) async =>
      PortalContactChangeResponse.fromJson(
        await _cliente.post('/portal/v1/me/contact', corpo: troca.toJson()),
      );

  /// Confere o código. Só agora o contato entra na ficha.
  Future<PortalMeDataResponse> confirmarTrocaDeContato(PortalContactVerify codigo) async =>
      PortalMeDataResponse.fromJson(
        await _cliente.post('/portal/v1/me/contact/verify', corpo: codigo.toJson()),
      );

  /// A cópia dos dados em PDF (AC-04 — LGPD art. 18, direito de acesso).
  ///
  /// Bytes, como o extrato: o documento é o retrato da ficha agora, e guardá-lo num
  /// bucket criaria uma segunda cópia dos dados pessoais só para poder entregá-los.
  /// Cada chamada vira `tutor.exported` na trilha — é a prova de que o direito foi
  /// exercido.
  Future<ArquivoDoPortal> meusDadosEmPdf(DateTime hoje) => _cliente.arquivo(
        '/portal/v1/me/export/pdf',
        nomePadrao: 'meus-dados-${_diaDoArquivo(hoje)}.pdf',
      );

  /// A mesma exportação em JSON — a portabilidade do art. 19, o arquivo que outro
  /// sistema consegue importar.
  ///
  /// Vai por `arquivo`, e não por `get`: o app não lê este JSON, entrega-o. Decodificar
  /// e codificar de novo só arriscaria mudar o que o servidor escreveu. A rota não manda
  /// `content-disposition`, então o nome é sempre o de reserva.
  Future<ArquivoDoPortal> meusDadosEmJson(DateTime hoje) => _cliente.arquivo(
        '/portal/v1/me/export',
        nomePadrao: 'meus-dados-${_diaDoArquivo(hoje)}.json',
      );

  /// O pedido de exclusão (AC-05). **Registra, não apaga**: vira uma linha na fila da
  /// equipe, que responde em até 15 dias. `semNulos` porque o motivo é opcional, e
  /// ausente — não `null`.
  Future<PortalMeDataResponse> pedirExclusao(PortalDeletionRequestInput pedido) async =>
      PortalMeDataResponse.fromJson(
        await _cliente.post('/portal/v1/me/deletion-request', corpo: semNulos(pedido.toJson())),
      );

  static String _diaDoArquivo(DateTime dia) => dia.toIso8601String().substring(0, 10);
}
