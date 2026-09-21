import 'package:flutter/material.dart';

import '../../arquivos.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';

/// Os lançamentos da conta (AC-01 de MOD-PORTAL-08).
///
/// **A nota interna do lançamento não existe aqui** — nem escondida, nem filtrada num
/// `map`. O servidor não a consulta (AC-02), e é lá que a garantia precisa morar: um
/// filtro na tela significaria o texto ter viajado até o celular.
///
/// A paginação é **por página**, e não por cursor como o histórico do pet. A razão está
/// no dado: o extrato ordena por `occurred_at`, que repete — três serviços do mesmo dia
/// entram no mesmo instante —, e um cursor por data pularia ou repetiria linhas. O
/// `total` da resposta é como a tela sabe quando parar de oferecer "Ver mais".
class Extrato extends StatefulWidget {
  const Extrato({super.key, required this.sessao, required this.inicial});

  final Sessao sessao;
  final PortalStatementResponse inicial;

  @override
  State<Extrato> createState() => _ExtratoState();
}

class _ExtratoState extends State<Extrato> {
  late List<PortalStatementEntry> _linhas = [...widget.inicial.entries];
  late int _pagina = widget.inicial.page;
  bool _carregando = false;
  String? _erro;

  /// O puxar-para-atualizar traz uma primeira página nova, e as já pedidas vêm dentro
  /// dela — continuar acrescentando sobre a lista antiga duplicaria cada lançamento.
  @override
  void didUpdateWidget(Extrato anterior) {
    super.didUpdateWidget(anterior);
    if (!identical(widget.inicial, anterior.inicial)) {
      _linhas = [...widget.inicial.entries];
      _pagina = widget.inicial.page;
      _erro = null;
    }
  }

  Future<void> _mais() async {
    if (_carregando) return;
    setState(() {
      _carregando = true;
      _erro = null;
    });
    try {
      final pagina = await widget.sessao.api.extrato(pagina: _pagina + 1, limite: 10);
      if (!mounted) return;
      setState(() {
        _linhas.addAll(pagina.entries);
        _pagina = pagina.page;
      });
    } catch (erro) {
      if (!mounted) return;
      setState(() => _erro = mensagemDoErro(erro));
    } finally {
      if (mounted) setState(() => _carregando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final tempo = widget.sessao.tempo;
    final faltam = widget.inicial.total - _linhas.length;

    final cabecalho = CabecalhoDeSecao(
      icone: Icons.account_balance_wallet_rounded,
      base: Tons.dinheiro,
      titulo: 'Lançamentos',
      descricao: _linhas.isEmpty
          ? 'Os atendimentos e os pagamentos aparecem aqui assim que forem registrados.'
          : null,
    );

    if (_linhas.isEmpty) return PilhaDeLinhas(cabecalho: cabecalho, filhos: const []);

    return PilhaDeLinhas(
      cabecalho: cabecalho,
      filhos: [
        for (final linha in _linhas)
          _LinhaDoExtrato(sessao: widget.sessao, entrada: linha, tempo: tempo),
      ],
      rodape: _erro != null || faltam > 0
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_erro != null) ...[
                  Text(
                    _erro!,
                    style: tema.textTheme.bodySmall?.copyWith(color: context.tokens.perigo),
                  ),
                  const SizedBox(height: 10),
                ],
                if (faltam > 0)
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

/// Um lançamento.
///
/// O valor **já vem com sinal** do servidor — crédito positivo, débito negativo —, então
/// a tela não recombina uma direção com um valor absoluto. É uma conta a menos para
/// errar numa das duas listas.
///
/// O lançamento estornado **aparece riscado** em vez de sumir: quem reclamou de uma
/// cobrança quer ver que ela foi desfeita, e um extrato que apaga o próprio erro faz
/// duvidar do resto.
class _LinhaDoExtrato extends StatelessWidget {
  const _LinhaDoExtrato({
    required this.sessao,
    required this.entrada,
    required this.tempo,
  });

  final Sessao sessao;
  final PortalStatementEntry entrada;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final credito = entrada.amountCents > 0;

    final descricao = [
      tempo.dia(entrada.occurredAt),
      ?entrada.petName,
      if (entrada.reversed) 'estornado',
    ].join(' · ');

    return Linha(
      // O chip separa dinheiro que entrou de dinheiro que saiu pelo desenho, antes do
      // sinal: a nota é o pagamento, a carteira é o atendimento lançado na conta. O tom
      // é o mesmo nos dois — dinheiro é dinheiro —, e quem diz a direção continua sendo
      // o sinal e o verde do valor.
      inicio: ChipDeIcone(
        credito ? Icons.receipt_long_rounded : Icons.account_balance_wallet_rounded,
        tamanho: 40,
        base: Tons.dinheiro,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entrada.description,
                  style: tema.textTheme.titleSmall?.copyWith(
                    fontSize: 15,
                    decoration: entrada.reversed ? TextDecoration.lineThrough : null,
                    decorationColor: t.discreta,
                    color: entrada.reversed ? t.discreta : t.tinta,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  descricao,
                  style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
                ),

                // O recibo só existe onde houve pagamento, e o estornado não tem um que
                // valha. Ele fica **dentro** da linha e não é a linha inteira: a linha
                // do extrato é leitura, e transformá-la num download faria o dedo que
                // rola a lista baixar PDF sem querer.
                if (entrada.paymentId != null && !entrada.reversed)
                  _BotaoDoRecibo(sessao: sessao, paymentId: entrada.paymentId!),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              '${credito ? '+' : '−'}${reais(entrada.amountCents.abs())}',
              style: tema.textTheme.titleSmall?.copyWith(
                fontSize: 14.5,
                decoration: entrada.reversed ? TextDecoration.lineThrough : null,
                decorationColor: t.discreta,
                color: entrada.reversed
                    ? t.discreta
                    : credito
                        ? t.sucesso
                        : t.tinta,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Baixar recibo" (AC-03).
///
/// São **duas** idas ao servidor, e não uma: a primeira pergunta o endereço assinado, a
/// segunda é o navegador do aparelho buscando o PDF. A assinatura tem vida curta, então
/// ela é pedida no toque e não junto da lista — endereços assinados na carga da tela
/// venceriam enquanto o tutor rola.
///
/// Três desfechos, e o do meio é o que se esquece: **recibo sem arquivo não é erro**. O
/// PDF nasce depois do pagamento, fora da transação, e quem tocou merece "está sendo
/// gerado" em vez de um endereço morto ou um vermelho que não explica nada.
class _BotaoDoRecibo extends StatefulWidget {
  const _BotaoDoRecibo({required this.sessao, required this.paymentId});

  final Sessao sessao;
  final String paymentId;

  @override
  State<_BotaoDoRecibo> createState() => _BotaoDoReciboState();
}

class _BotaoDoReciboState extends State<_BotaoDoRecibo> {
  bool _buscando = false;

  Future<void> _abrir() async {
    if (_buscando) return;
    setState(() => _buscando = true);

    try {
      final recibo = await widget.sessao.api.recibo(widget.paymentId);
      if (!mounted) return;

      if (recibo.url == null) {
        _dizer('O recibo está sendo gerado. Tente de novo em alguns instantes.');
        return;
      }

      final abriu = await abrirEndereco(Uri.parse(recibo.url!));
      if (!mounted || abriu) return;
      _dizer('Não foi possível abrir o recibo neste aparelho.');
    } catch (erro) {
      // 404 aqui é pagamento que não é deste tutor (RN-03), e ele **não** ganha
      // tratamento próprio: dizer "não é seu" a quem adivinhou um id confirmaria que
      // aquele pagamento existe.
      if (mounted) _dizer(mensagemDoErro(erro));
    } finally {
      if (mounted) setState(() => _buscando = false);
    }
  }

  void _dizer(String texto) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(texto)));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.only(top: 7),
      child: InkWell(
        onTap: _buscando ? null : _abrir,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          // O alvo do toque cresce para além do texto: 12px de altura de letra é menos
          // que metade de um dedo, e o que está em volta é uma lista que rola.
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_buscando)
                const Padding(
                  padding: EdgeInsets.only(right: 7),
                  child: Girando(tamanho: 12),
                )
              else
                Padding(
                  padding: const EdgeInsets.only(right: 5),
                  child: Icon(Icons.download_rounded, size: 14, color: t.acentoTinta),
                ),
              // `Flexible` com reticências: a linha divide a largura do celular com o
              // valor, e o que sobra para cá é pouco. É o mesmo conserto das pílulas de
              // ação do agendamento — e ele não é só do teste: a fonte grande da
              // acessibilidade reproduz o estouro no aparelho.
              Flexible(
                child: Text(
                  _buscando ? 'Abrindo…' : 'Baixar recibo',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: t.acentoTinta,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
