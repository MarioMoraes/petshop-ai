import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';
import 'package:timezone/data/latest_10y.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// A **única** forma de um instante virar texto neste app.
///
/// O backend manda tudo em UTC — a grade de horários desce `2026-09-22T13:00:00.000Z`
/// para um horário que o petshop chama de 10:00 — e manda junto, em toda resposta que
/// carrega instante, o fuso do estabelecimento. Formatar com o fuso do **aparelho**
/// funciona na mesa de quem desenvolve e mente para o cliente que viajou, ou para o
/// petshop que não está em São Paulo.
///
/// Por isso não há `DateTime.toString()` nem `DateFormat` solto nas telas: toda hora
/// visível passa por aqui, e aqui exige o fuso. É a mesma decisão que o `momento`,
/// `horaDoDia` e `isoLocal` de `modules/agent/tools.ts` tomam do lado do servidor.
class TenantTime {
  TenantTime(this.timezone) : _local = _resolver(timezone);

  /// O fuso do estabelecimento, como o backend o nomeia (`America/Sao_Paulo`).
  final String timezone;
  final tz.Location _local;

  static bool _fusosCarregados = false;
  static bool _localeCarregado = false;

  /// Carrega a base de fusos e o locale `pt_BR`. Idempotente.
  ///
  /// **Precisa ser aguardado uma vez na subida do app.** O `intl` não traz os nomes de
  /// mês e de dia da semana embutidos: sem esta chamada, `DateFormat('EEEE', 'pt_BR')`
  /// lança em tempo de execução, e não na compilação — um `flutter analyze` limpo não
  /// diz nada a respeito.
  static Future<void> iniciar() async {
    _carregarFusos();
    if (_localeCarregado) return;
    await initializeDateFormatting('pt_BR', null);
    _localeCarregado = true;
  }

  static void _carregarFusos() {
    if (_fusosCarregados) return;
    tzdata.initializeTimeZones();
    _fusosCarregados = true;
  }

  static tz.Location _resolver(String nome) {
    _carregarFusos();
    try {
      return tz.getLocation(nome);
    } on tz.LocationNotFoundException {
      // Fuso desconhecido é defeito de dado, não motivo para a tela não abrir.
      return tz.getLocation('America/Sao_Paulo');
    }
  }

  tz.TZDateTime _no(String isoUtc) =>
      tz.TZDateTime.from(DateTime.parse(isoUtc).toUtc(), _local);

  /// `14:30`
  String hora(String isoUtc) => DateFormat('HH:mm', 'pt_BR').format(_no(isoUtc));

  /// `22/09`
  String diaCurto(String isoUtc) => DateFormat('dd/MM', 'pt_BR').format(_no(isoUtc));

  /// `2026` — a linha de baixo da coluna de data do histórico, que desce anos.
  String ano(String isoUtc) => DateFormat('yyyy', 'pt_BR').format(_no(isoUtc));

  /// `terça, 22 de setembro`
  String diaPorExtenso(String isoUtc) =>
      DateFormat("EEEE, d 'de' MMMM", 'pt_BR').format(_no(isoUtc));

  /// `22/09/2026` — a data sem a hora, para o que aconteceu num dia e não num instante.
  ///
  /// O lançamento do extrato é disso: três serviços do mesmo dia entram no mesmo
  /// instante, e mostrar `09:00` em todos diria uma precisão que o dado não tem.
  String dia(String isoUtc) => DateFormat('dd/MM/yyyy', 'pt_BR').format(_no(isoUtc));

  /// `22/09/2026 às 14:30`
  String completo(String isoUtc) =>
      "${DateFormat('dd/MM/yyyy', 'pt_BR').format(_no(isoUtc))} às ${hora(isoUtc)}";

  /// O dia, no formato que as rotas de disponibilidade esperam (`YYYY-MM-DD`).
  ///
  /// Quem escolhe é o **dia**, não um instante: a rota recebe `date=2026-09-22` e o
  /// servidor resolve a grade daquele dia no fuso dele.
  String diaParaConsulta(DateTime dia) => DateFormat('yyyy-MM-dd').format(dia);

  /// Hoje no fuso do petshop — que pode não ser o hoje do aparelho.
  DateTime get hoje {
    final agora = tz.TZDateTime.now(_local);
    return DateTime(agora.year, agora.month, agora.day);
  }
}
