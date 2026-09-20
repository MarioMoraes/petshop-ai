import 'dart:convert';

/// Um erro do Portal, com o corpo inteiro e não só a frase.
///
/// O backend responde `application/problem+json`, e vários erros do Portal mandam
/// **contexto junto**: os horários próximos de um conflito, os alertas clínicos que
/// faltam reconhecer, o valor da taxa de cancelamento, as janelas alternativas do
/// leva-e-traz. Uma classe que guardasse só `detail` jogaria fora exatamente o que torna
/// o erro acionável — a tela poderia dizer "não deu", mas não "que tal às 14h".
class PortalError implements Exception {
  PortalError({
    required this.status,
    required this.code,
    required this.message,
    this.extra = const {},
  });

  final int status;
  final String code;
  final String message;

  /// O resto do `problem+json`, sem a moldura (`type`, `title`, `status`, `detail`).
  final Map<String, dynamic> extra;

  /// A lista de horários que um 409 oferece no lugar do que foi recusado.
  List<String>? get alternativeStartsAt {
    final valor = extra['alternativeStartsAt'];
    return valor is List ? valor.cast<String>() : null;
  }

  /// Os alertas clínicos que o agendamento exige reconhecer antes de gravar.
  List<String>? get alertsToAcknowledge {
    final valor = extra['alerts'] ?? extra['acknowledgedAlerts'];
    return valor is List ? valor.cast<String>() : null;
  }

  /// A taxa que o cancelamento fora da janela cobra, em centavos.
  int? get feeCents {
    final valor = extra['feeCents'] ?? extra['cancelFeeCents'];
    return valor is int ? valor : null;
  }

  /// O estabelecimento não existe, não está visível, ou o plano não tem Portal.
  ///
  /// As três respondem o mesmo código de propósito: quem digitou o subdomínio errado
  /// não tem por que descobrir se o petshop existe e deixou de pagar.
  bool get tenantDesconhecido => code == 'ERR_PORTAL_001';

  /// Falta vincular a ficha do petshop a esta conta.
  bool get semVinculo => status == 401;

  static PortalError deResposta(int status, String corpo) {
    Map<String, dynamic> json;
    try {
      final decodificado = jsonDecode(corpo);
      json = decodificado is Map<String, dynamic> ? decodificado : {};
    } on FormatException {
      json = {};
    }

    const moldura = {'type', 'title', 'status', 'detail', 'code', 'traceId'};
    return PortalError(
      status: status,
      code: json['code'] as String? ?? 'ERR_DESCONHECIDO',
      message: json['detail'] as String? ?? json['title'] as String? ?? 'Falha inesperada',
      extra: {
        for (final entrada in json.entries)
          if (!moldura.contains(entrada.key)) entrada.key: entrada.value,
      },
    );
  }

  @override
  String toString() => 'PortalError($status $code): $message';
}
