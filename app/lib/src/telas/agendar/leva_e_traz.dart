import 'package:flutter/material.dart';

import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/comuns.dart';
import '../../ui/listas.dart';
import '../../ui/tema.dart';

/// O leva-e-traz pedido **junto** do agendamento (MOD-PORTAL-07).
///
/// Não existe pedido de corrida solto: no MOD-TAXI o dono da corrida é o agendamento
/// (RN-01), e uma segunda porta criaria uma segunda fila de aprovação além da que o
/// agendamento online já pode ter — o tutor esperaria duas confirmações para uma tarde
/// só. É por isso que este cartão mora dentro do formulário de marcar horário, e não
/// numa tela própria com um botão no Início.
///
/// Ida e volta são **duas linhas** em `taxi_rides` (RN-02), e por isso duas caixas
/// independentes: quem leva o pet e quer que o petshop o traga é caso comum, e o
/// contrário também.

/// O cartão aparece por dois motivos e some por um.
///
/// Aparece quando dá para pedir, e aparece quando **não** dá por um motivo do próprio
/// tutor — endereço faltando ou fora da área —, porque essa é a informação que ele
/// precisa para resolver. Some quando o petshop simplesmente não faz leva-e-traz: aí não
/// é uma negativa, é um serviço que não existe, e anunciá-lo para negar em seguida só
/// ocuparia a tela.
bool ofereceLevaETraz(PortalTaxiOffer? oferta) =>
    oferta != null &&
    oferta.reason != PortalTaxiUnavailableReason.DISABLED &&
    oferta.reason != PortalTaxiUnavailableReason.NOT_CONFIGURED;

class CartaoDoLevaETraz extends StatelessWidget {
  const CartaoDoLevaETraz({
    super.key,
    required this.oferta,
    required this.levar,
    required this.trazer,
    required this.aoMudarLevar,
    required this.aoMudarTrazer,
    this.etiqueta,
  });

  final PortalTaxiOffer oferta;
  final bool levar;
  final bool trazer;
  final ValueChanged<bool> aoMudarLevar;
  final ValueChanged<bool> aoMudarTrazer;
  final String? etiqueta;

  int get _pernas => (levar ? 1 : 0) + (trazer ? 1 : 0);

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final porPerna = oferta.priceCentsPerLeg ?? 0;
    final endereco = oferta.address;

    return CartaoDeSecao(
      cabecalho: CabecalhoDeSecao(
        icone: Icons.local_shipping_rounded,
        base: Tons.tempo,
        titulo: 'Leva-e-traz',
        etiqueta: etiqueta,
        descricao:
            oferta.available ? 'Buscamos e devolvemos o seu pet em casa' : null,
      ),
      filhos: oferta.available
          ? [
              // **O preço é por perna.** Somar as duas aqui esconderia que quem pede só
              // a ida paga metade, e é justamente essa a escolha que o tutor faz.
              Escolha(
                marcada: levar,
                aoMudar: aoMudarLevar,
                titulo: 'Buscar em casa',
                aDireita: reais(porPerna),
              ),
              const SizedBox(height: 8),
              Escolha(
                marcada: trazer,
                aoMudar: aoMudarTrazer,
                titulo: 'Devolver em casa',
                aDireita: reais(porPerna),
              ),

              // O endereço aparece antes de virar corrida: é para lá que o motorista
              // vai, e esta é a última tela em que alguém pode notar que a família se
              // mudou.
              if (endereco != null) ...[
                const SizedBox(height: 12),
                Text(
                  _pernas > 0
                      ? 'Vamos até ${endereco.label}.'
                      : 'No endereço ${endereco.label}.',
                  style: tema.textTheme.bodySmall,
                ),
              ],

              if (_pernas > 0) ...[
                const SizedBox(height: 6),
                Text(
                  'A janela é de até ${oferta.windowMinutes} minutos antes ou depois '
                  'do atendimento. Avisamos quando o motorista sair.',
                  style: tema.textTheme.bodySmall,
                ),
              ],
            ]
          : [
              // A frase vem pronta do servidor: o motivo viaja como enum para a tela
              // decidir se mostra o cartão, e como texto para não reescrever aqui o que
              // o Portal já diz na web.
              Text(
                oferta.message ?? 'Leva-e-traz indisponível.',
                style: tema.textTheme.bodySmall,
              ),
            ],
    );
  }
}

/// As corridas criadas, no comprovante.
///
/// **Sem mapa, sem posição do veículo e sem o nome do motorista** (AC-05): o
/// rastreamento é questão da v2, e o nome de quem dirige é dado de um trabalhador
/// exibido a um cliente. O que resolve a ansiedade de quem espera é o status e a janela.
///
/// `legLabel` e `statusText` vêm prontos do servidor, por `taxiStatusTutorText` — o
/// rótulo do painel é escrito para a operação, e "Sem motorista" no celular do tutor lê
/// como falha.
class CorridasDoAgendamento extends StatelessWidget {
  const CorridasDoAgendamento({
    super.key,
    required this.corridas,
    required this.tempo,
  });

  final List<PortalTaxiRide> corridas;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    if (corridas.isEmpty) return const SizedBox.shrink();
    final tema = Theme.of(context);
    final t = context.tokens;

    // Mesma faixa da lista de agendamentos, e de propósito: o transporte é assunto de
    // outro fornecedor dentro do mesmo compromisso, e o fundo próprio é o que o separa
    // do horário sem precisar de um segundo cartão.
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
      decoration: BoxDecoration(
        color: t.chip,
        borderRadius: BorderRadius.circular(Raio.controle),
        border: Border.all(color: t.linha),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final corrida in corridas)
            Padding(
              padding:
                  EdgeInsets.only(bottom: corrida == corridas.last ? 0 : 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.local_shipping_rounded, size: 17, color: t.fraca),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${corrida.legLabel} · ${reais(corrida.priceCents)}',
                          style: tema.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                            color: t.tinta,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${corrida.statusText} · entre '
                          '${tempo.hora(corrida.windowStartsAt)} e '
                          '${tempo.hora(corrida.windowEndsAt)}',
                          style: tema.textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
