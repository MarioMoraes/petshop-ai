import 'package:flutter/material.dart';

import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import 'rotulos.dart';

/// O histórico do pet (MOD-PORTAL-04).
///
/// A resposta à pergunta que faz o tutor ligar hoje: "quando foi o último banho?". Por
/// isso é uma lista do mais recente para o mais antigo, e não um calendário — ninguém
/// abre isto para navegar no tempo, abre para ver o topo.
///
/// **"Ver mais", e não rolagem infinita** — o plano do app previa rolagem infinita, e a
/// web já tinha decidido o contrário, pelo motivo que num celular só fica mais forte: no
/// 4G, a rolagem dispara buscas que ninguém pediu, e cada uma delas custa do pacote de
/// dados de quem está lendo. A primeira página vem junto da ficha, numa chamada que já
/// ia acontecer; as seguintes só quando alguém pede.
///
/// O atendimento anulado **aparece**, e riscado (AC-03). Ele existiu no dia em que o
/// tutor levou o pet ali, e uma linha do tempo que o esconde faz duvidar de tudo o que a
/// tela mostra. O motivo interno da anulação, esse não vem.
class Historico extends StatefulWidget {
  const Historico({
    super.key,
    required this.sessao,
    required this.petId,
    required this.nome,
    required this.inicial,
    required this.tempo,
  });

  final Sessao sessao;
  final String petId;
  final String nome;
  final PortalTimelineResponse inicial;
  final TenantTime tempo;

  @override
  State<Historico> createState() => _HistoricoState();
}

class _HistoricoState extends State<Historico> {
  late List<PortalTimelineEntry> _entradas = [...widget.inicial.entries];
  late String? _cursor = widget.inicial.nextCursor;
  bool _carregando = false;
  String? _erro;

  /// A ficha recarregada traz uma primeira página nova, e as páginas que já tinham sido
  /// pedidas vêm dentro dela — continuar acrescentando sobre a lista antiga duplicaria
  /// cada entrada.
  @override
  void didUpdateWidget(Historico anterior) {
    super.didUpdateWidget(anterior);
    if (!identical(widget.inicial, anterior.inicial)) {
      _entradas = [...widget.inicial.entries];
      _cursor = widget.inicial.nextCursor;
      _erro = null;
    }
  }

  Future<void> _mais() async {
    final cursor = _cursor;
    if (cursor == null || _carregando) return;

    setState(() {
      _carregando = true;
      _erro = null;
    });
    try {
      final pagina =
          await widget.sessao.api.timeline(widget.petId, cursor: cursor, limite: 10);
      if (!mounted) return;
      setState(() {
        _entradas = [..._entradas, ...pagina.entries];
        _cursor = pagina.nextCursor;
      });
    } on PortalError catch (e) {
      if (mounted) setState(() => _erro = e.message);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _carregando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cabecalho = CabecalhoDeSecao(
      icone: Icons.favorite_outline,
      titulo: 'Histórico',
      descricao: _entradas.isEmpty
          ? 'O ${widget.nome} ainda não tem atendimento registrado. Assim que ele '
              'passar por aqui, o que foi feito aparece nesta lista.'
          : null,
    );

    return PilhaDeLinhas(
      cabecalho: cabecalho,
      filhos: [
        for (final entrada in _entradas)
          _Entrada(entrada: entrada, tempo: widget.tempo),
      ],
      rodape: _erro != null || _cursor != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_erro != null) ...[
                  Text(_erro!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error, fontSize: 13)),
                  const SizedBox(height: 8),
                ],
                if (_cursor != null)
                  OutlinedButton(
                    onPressed: _carregando ? null : _mais,
                    child: Text(_carregando ? 'Carregando…' : 'Ver mais'),
                  ),
              ],
            )
          : null,
    );
  }
}

class _Entrada extends StatelessWidget {
  const _Entrada({required this.entrada, required this.tempo});

  final PortalTimelineEntry entrada;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final anulado = entrada.voidedAt != null;
    final cinza = tema.colorScheme.onSurfaceVariant;

    return Linha(
      // A data à esquerda, em coluna de largura fixa: é por ela que o olho desce a
      // lista, e um marcador que muda de largura conforme o mês obriga a reler a cada
      // linha.
      inicio: SizedBox(
        width: 48,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(tempo.diaCurto(entrada.startedAt),
                style: tema.textTheme.bodyMedium
                    ?.copyWith(fontWeight: FontWeight.w700)),
            Text(tempo.ano(entrada.startedAt),
                style: tema.textTheme.bodySmall?.copyWith(color: cinza, fontSize: 11)),
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            entrada.services.isNotEmpty
                ? entrada.services.join(', ')
                : rotuloTipoDeAtendimento(entrada.type),
            style: tema.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: anulado ? cinza : null,
              decoration: anulado ? TextDecoration.lineThrough : null,
            ),
          ),
          if (anulado)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                'Registro cancelado pelo estabelecimento em '
                '${tempo.diaCurto(entrada.voidedAt!)}',
                style: tema.textTheme.bodySmall?.copyWith(color: cinza, fontSize: 12),
              ),
            )
          else ...[
            if (entrada.professional != null)
              Text('com ${entrada.professional}',
                  style: tema.textTheme.bodySmall?.copyWith(color: cinza)),
            if (entrada.weightKg != null)
              Text('Pesou ${rotuloPeso(entrada.weightKg)}',
                  style: tema.textTheme.bodySmall?.copyWith(color: cinza)),
            for (final nota in entrada.notes)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(nota, style: tema.textTheme.bodySmall?.copyWith(height: 1.4)),
              ),
            if (entrada.photoUrls.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: SizedBox(
                  height: 76,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: entrada.photoUrls.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 8),
                    itemBuilder: (_, i) => ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        entrada.photoUrls[i],
                        width: 76,
                        height: 76,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
