import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../arquivos.dart';
import '../../auth/sessao.dart';
import '../../dinheiro.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import 'extrato.dart';

/// Minha conta (MOD-PORTAL-08).
///
/// A tela responde três perguntas, nesta ordem, que é a ordem em que o tutor as faz:
/// **quanto eu devo**, **o que eu já paguei** e **como eu pago**. Pacote com crédito
/// entra entre a primeira e a segunda, porque é dinheiro que já saiu do bolso dele.
///
/// **Não há botão de pagar, e a ausência é deliberada** (AC-05). Não existe meio de
/// pagamento integrado; um "pagar agora" que abrisse um diálogo pedindo para procurar o
/// petshop seria pior que o bloco honesto com a chave PIX e o horário de atendimento.
class MinhaConta extends StatelessWidget {
  const MinhaConta({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    return Tela(
      appBar: AppBar(title: const Text('Minha conta')),
      corpo: CarregarDados<_Conta>(
        // As duas chamadas saem **juntas**: o saldo e a primeira página do extrato são a
        // mesma tela, e pedi-las em sequência somaria duas idas de rede antes do
        // primeiro pixel. É o `Promise.all` da página do Portal na web.
        buscar: () async {
          final respostas = await Future.wait([
            sessao.api.financeiro(),
            sessao.api.extrato(limite: 10),
          ]);
          return _Conta(
            respostas[0] as PortalFinanceResponse,
            respostas[1] as PortalStatementResponse,
          );
        },
        construir: (context, conta, recarregar) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            _CartaoDoSaldo(conta: conta.financeiro, sessao: sessao),
            if (conta.financeiro.packages.isNotEmpty) ...[
              const SizedBox(height: 22),
              _Pacotes(pacotes: conta.financeiro.packages, sessao: sessao),
            ],
            const SizedBox(height: 22),
            Extrato(sessao: sessao, inicial: conta.extrato),
            const SizedBox(height: 14),
            _BotaoDoExtratoEmPdf(sessao: sessao),
            if (deveEmCentavos(conta.financeiro.balanceCents) > 0) ...[
              const SizedBox(height: 22),
              _ComoPagar(
                instrucoes: conta.financeiro.howToPay,
                petshop: sessao.contexto!.tenant.name,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// O que a tela precisa de uma vez só.
class _Conta {
  const _Conta(this.financeiro, this.extrato);

  final PortalFinanceResponse financeiro;
  final PortalStatementResponse extrato;
}

/// O saldo, dito na língua de quem lê.
///
/// O número guardado segue a convenção da plataforma — **negativo é dívida** —, e
/// nenhuma tela refaz essa conta: `deveEmCentavos` e `creditoEmCentavos` existem porque
/// a versão anterior desta leitura, feita à mão no início do Portal na web, dizia "Sem
/// pendências" a quem devia.
class _CartaoDoSaldo extends StatelessWidget {
  const _CartaoDoSaldo({required this.conta, required this.sessao});

  final PortalFinanceResponse conta;
  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final deve = deveEmCentavos(conta.balanceCents);
    final credito = creditoEmCentavos(conta.balanceCents);

    return Cartao(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // O número é a resposta da tela, e por isso ele — e não o chip — manda no
          // cartão: o ícone abre a linha do rótulo, e o valor vem abaixo, sozinho na
          // largura toda.
          Row(
            children: [
              // **A dívida é vermelha, e não da cor da marca.** O chip do assunto
              // costuma vir do domínio — dinheiro é verde em todo o resto da tela —,
              // mas aqui ele não está dizendo "financeiro": está dizendo "em aberto",
              // que é a mesma coisa que o número embaixo diz em `t.perigo`. Com a cor
              // da marca, o petshop de fachada azul teria a etiqueta azul ao lado de um
              // valor vermelho, e as duas peças contariam histórias diferentes.
              if (deve > 0)
                ChipDeIcone(
                  Icons.account_balance_wallet_rounded,
                  tamanho: 34,
                  fundo: t.perigoSuave,
                  aro: t.perigo.withValues(alpha: 0.22),
                  cor: t.perigo,
                )
              else
                const ChipDeIcone(
                  Icons.verified_rounded,
                  tamanho: 34,
                  base: Tons.dinheiro,
                ),
              const SizedBox(width: 11),
              Etiqueta(
                deve > 0 ? 'Em aberto' : 'Sua conta',
                cor: deve > 0 ? t.perigo : t.discreta,
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            deve > 0
                ? reais(deve)
                : credito > 0
                    ? reais(credito)
                    : 'Em dia',
            style: tema.textTheme.headlineLarge?.copyWith(
              color: deve > 0 ? t.perigo : t.tinta,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            deve > 0 && conta.oldestOpenDebitAt != null
                ? 'O lançamento mais antigo em aberto é de '
                    '${sessao.tempo.dia(conta.oldestOpenDebitAt!)}.'
                : credito > 0
                    ? 'Este valor entra como desconto no seu próximo atendimento.'
                    : 'Nenhum valor em aberto por aqui.',
            style: tema.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

/// Os pacotes com crédito de pé (AC-04).
///
/// A data de expiração vem **sempre**, e a regra de que o crédito não usado se perde vem
/// escrita junto. Dizê-la só na semana do vencimento seria avisar tarde: quem comprou
/// quatro banhos em janeiro precisa saber em janeiro até quando pode usá-los.
class _Pacotes extends StatelessWidget {
  const _Pacotes({required this.pacotes, required this.sessao});

  final List<PortalPackage> pacotes;
  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return PilhaDeLinhas(
      cabecalho: const CabecalhoDeSecao(
        icone: Icons.confirmation_number_rounded,
        base: Tons.dinheiro,
        titulo: 'Seus pacotes',
      ),
      filhos: [
        for (final pacote in pacotes)
          Linha(
            inicio: const ChipDeIcone(
              Icons.confirmation_number_rounded,
              tamanho: 40,
              base: Tons.dinheiro,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextoDaLinha(
                    titulo: pacote.name,
                    meta: [
                      pacote.creditsRemaining == 1
                          ? '1 crédito restante'
                          : '${pacote.creditsRemaining} créditos restantes',
                      pacote.petName,
                    ],
                    extra: Text(
                      'Expira em ${sessao.tempo.dia(pacote.expiresAt)}.',
                      style: tema.textTheme.bodySmall
                          ?.copyWith(color: context.tokens.discreta),
                    ),
                  ),
                ),
                if (pacote.expiringSoon) ...[
                  const SizedBox(width: 10),
                  const Selo(texto: 'Vence logo', erro: true),
                ],
              ],
            ),
          ),
      ],
      rodape: Text(
        'Crédito não usado até a data de expiração é perdido, e não é devolvido em '
        'dinheiro.',
        style: tema.textTheme.bodySmall?.copyWith(color: context.tokens.discreta),
      ),
    );
  }
}

/// "Baixar extrato em PDF" (AC-02 de MOD-DOC-09).
///
/// Fica **depois** dos lançamentos porque é o que se faz quando a leitura na tela não
/// bastou — levar o papel para outro lugar.
///
/// O caminho é diferente do recibo, e a diferença é do documento: o extrato não é
/// arquivado, então não há URL a assinar. Ele desce em bytes, atrás do token, e o app
/// grava no diretório temporário e entrega à folha do sistema — que é onde o aparelho já
/// sabe salvar, imprimir e mandar por e-mail.
class _BotaoDoExtratoEmPdf extends StatefulWidget {
  const _BotaoDoExtratoEmPdf({required this.sessao});

  final Sessao sessao;

  @override
  State<_BotaoDoExtratoEmPdf> createState() => _BotaoDoExtratoEmPdfState();
}

class _BotaoDoExtratoEmPdfState extends State<_BotaoDoExtratoEmPdf> {
  bool _baixando = false;

  Future<void> _baixar() async {
    if (_baixando) return;

    // O retângulo do botão, medido **antes** do `await`: no iPad a folha é um popover e
    // precisa saber de onde sai, e depois da espera este widget pode já não estar na
    // árvore para responder onde está.
    final caixa = context.findRenderObject() as RenderBox?;
    final origem = caixa == null || !caixa.hasSize
        ? null
        : caixa.localToGlobal(Offset.zero) & caixa.size;

    setState(() => _baixando = true);
    try {
      final arquivo = await widget.sessao.api.extratoEmPdf(widget.sessao.tempo.hoje);
      await entregarArquivo(arquivo, origem: origem);
    } catch (erro) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mensagemDoErro(erro))),
        );
      }
    } finally {
      if (mounted) setState(() => _baixando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: _baixando ? null : _baixar,
      icon: _baixando
          ? const Girando(tamanho: 16)
          : const Icon(Icons.picture_as_pdf_rounded, size: 18),
      label: Text(_baixando ? 'Preparando…' : 'Baixar extrato em PDF'),
    );
  }
}

/// AC-05 — o caminho real para pagar.
///
/// Só aparece para quem deve: oferecer a chave PIX a quem está em dia é convidar a um
/// pagamento sem destino, que depois alguém do balcão tem de conciliar à mão.
class _ComoPagar extends StatelessWidget {
  const _ComoPagar({required this.instrucoes, required this.petshop});

  final PortalPaymentInstructions instrucoes;
  final String petshop;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final pix = instrucoes.pixKey;
    final contato = instrucoes.whatsapp ?? instrucoes.phone;
    final semNada = pix == null && contato == null;

    return Cartao(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const CabecalhoDeSecao(
            icone: Icons.payments_rounded,
            titulo: 'Como pagar',
          ),
          if (pix != null) ...[
            const SizedBox(height: 18),
            _ChavePix(chave: pix),
          ],
          if (contato != null) ...[
            const SizedBox(height: 16),
            Text('Falar com o $petshop',
                style: tema.textTheme.bodySmall?.copyWith(color: t.discreta)),
            const SizedBox(height: 3),
            Text(contato,
                style: tema.textTheme.bodyMedium
                    ?.copyWith(color: t.tinta, fontWeight: FontWeight.w500)),
          ],
          if (instrucoes.hours.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Horário de atendimento',
                style: tema.textTheme.bodySmall?.copyWith(color: t.discreta)),
            const SizedBox(height: 4),
            for (final linha in instrucoes.hours)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text('${linha.label}: ${linha.value}',
                    style: tema.textTheme.bodyMedium),
              ),
          ],
          if (semNada) ...[
            const SizedBox(height: 14),
            Text('Fale com o $petshop para combinar o pagamento.',
                style: tema.textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// A chave PIX, com o botão de copiar.
///
/// **Aqui o app diverge do Portal na web, de propósito.** Lá a chave é texto
/// selecionável, e o comentário diz por quê: copiar exigiria JavaScript no cliente, e
/// aquele cartão não tinha outro motivo para deixar de ser servidor. Num app não há
/// esse custo — e a chave aleatória tem 36 caracteres que ninguém digita no teclado do
/// banco sem errar.
class _ChavePix extends StatelessWidget {
  const _ChavePix({required this.chave});

  final String chave;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(
        color: t.chip,
        borderRadius: BorderRadius.circular(Raio.controle),
        border: Border.all(color: t.linha),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Chave PIX',
                    style: tema.textTheme.bodySmall?.copyWith(color: t.discreta)),
                const SizedBox(height: 4),
                SelectableText(
                  chave,
                  style: tema.textTheme.bodyMedium?.copyWith(
                    color: t.tinta,
                    fontWeight: FontWeight.w500,
                    // Algarismos de largura fixa: a chave aleatória é uma sequência
                    // sem espaço nenhum, e com largura variável os dígitos dançam entre
                    // as letras — que é o que faz conferir uma chave no olho ser
                    // cansativo.
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          _Copiar(chave: chave),
        ],
      ),
    );
  }
}

class _Copiar extends StatelessWidget {
  const _Copiar({required this.chave});

  final String chave;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Material(
      color: t.cartao,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () async {
          await Clipboard.setData(ClipboardData(text: chave));
          if (!context.mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Chave PIX copiada.')),
          );
        },
        child: Container(
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: t.linha),
          ),
          child: Icon(Icons.copy_rounded, size: 17, color: t.fraca),
        ),
      ),
    );
  }
}
