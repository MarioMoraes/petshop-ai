import '../models/portal_models.dart';

/// O que `POST /portal/v1/booking` devolve.
///
/// **É a única classe do app escrita à mão, e por um motivo nomeado:** esta resposta
/// não tem schema Zod. Ela é uma `interface` do TypeScript (`CreatedBooking`, em
/// `modules/portal/booking.ts`), e o gerador só alcança o que `toJSONSchema` consegue
/// ler. Até a fatia 5 o app supunha que a rota devolvia `PortalAppointmentDetail`, que é
/// o que a lista e o detalhe devolvem — e não devolve: **não há `actions`, `petId`,
/// `serviceIds` nem `source`**, e há dois campos que só existem aqui.
///
/// O que impede esta cópia de envelhecer em silêncio é `tool/smoke_booking.dart`, que
/// marca e cancela um horário de verdade. Foi ele que apanhou a suposição errada.
class AgendamentoCriado {
  AgendamentoCriado({
    required this.id,
    required this.status,
    required this.startsAt,
    required this.endsAt,
    required this.petName,
    required this.professionalName,
    required this.services,
    required this.totalCents,
    required this.awaitingApproval,
    required this.duplicate,
    required this.taxi,
    required this.taxiWarning,
  });

  final String id;
  final String status;
  final String startsAt;
  final String endsAt;
  final String petName;
  final String professionalName;
  final List<String> services;
  final int totalCents;

  /// `true` enquanto o petshop não decidiu a triagem — o horário está reservado, não
  /// confirmado, e o comprovante precisa dizer a diferença.
  final bool awaitingApproval;

  /// `true` quando o pedido reencontrou um agendamento que já existia.
  ///
  /// É o duplo toque, resolvido pela pergunta natural em vez de por uma chave de
  /// idempotência: mesmo pet, mesmo instante e ainda em pé devolve o que já existe. Para
  /// a tela dá no mesmo — o desfecho é o horário marcado —, e é por isso que ela não
  /// trata este campo.
  final bool duplicate;

  /// As corridas criadas junto (MOD-PORTAL-07). Uma por perna pedida, e vazia no
  /// pedido sem transporte — que segue sendo o caminho da maioria.
  final List<PortalTaxiRide> taxi;

  /// O que deu errado **só** com o transporte: o agendamento existe mesmo assim.
  ///
  /// É a recusa por endereço (AC-03) — sem endereço, fora de área, módulo desligado —,
  /// que não derruba o horário. A falta de **vaga** na van é outra coisa: ela acontece
  /// antes de o agendamento nascer, e chega como `ERR_TAXI_007` com horários
  /// alternativos, porque aí ainda dá para escolher outro.
  final String? taxiWarning;

  factory AgendamentoCriado.fromJson(Map<String, dynamic> json) => AgendamentoCriado(
        id: json['id'],
        status: json['status'],
        startsAt: json['startsAt'],
        endsAt: json['endsAt'],
        petName: json['petName'],
        professionalName: json['professionalName'],
        services: List<String>.from(json['services']),
        totalCents: json['totalCents'],
        awaitingApproval: json['awaitingApproval'],
        duplicate: json['duplicate'] ?? false,
        taxi: List<PortalTaxiRide>.from(
          (json['taxi'] ?? const []).map((x) => PortalTaxiRide.fromJson(x)),
        ),
        taxiWarning: json['taxiWarning'],
      );
}
