import 'package:flutter/material.dart';

import '../../api/portal_client.dart';
import '../../arquivos.dart';
import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import 'editar_perfil.dart';
import 'endereco.dart';
import 'pedir_exclusao.dart';
import 'trocar_contato.dart';

/// Meus dados (MOD-PORTAL-09).
///
/// Responde três perguntas em ordem de frequência: **o que vocês têm sobre mim**, **como
/// corrijo o que está errado** e **como saio daqui** — com o pedido de exclusão por
/// último e discreto, sem ser escondido.
///
/// As seções têm caminhos de escrita diferentes, e a diferença é a substância do módulo:
/// nome social e nascimento gravam direto; telefone e e-mail passam por um código enviado
/// ao contato **novo**; o pedido de exclusão não grava nada na ficha — vira uma linha
/// numa fila que a equipe do petshop vê.
class MeusDados extends StatelessWidget {
  const MeusDados({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    return Tela(
      appBar: AppBar(title: const Text('Meus dados')),
      corpo: CarregarDados<PortalMeDataResponse>(
        buscar: sessao.api.meusDados,
        construir: (context, dados, _) => _Corpo(sessao: sessao, inicial: dados),
      ),
    );
  }
}

/// **Um estado só, e toda escrita o substitui.** Cada rota de escrita devolve a ficha
/// inteira relida, e é ela que passa a valer — a tela nunca remenda o que tinha com o que
/// supôs ter salvado. O puxar-para-atualizar chega por `didUpdateWidget`.
class _Corpo extends StatefulWidget {
  const _Corpo({required this.sessao, required this.inicial});

  final Sessao sessao;
  final PortalMeDataResponse inicial;

  @override
  State<_Corpo> createState() => _CorpoState();
}

class _CorpoState extends State<_Corpo> {
  late PortalMeDataResponse _dados = widget.inicial;

  @override
  void didUpdateWidget(covariant _Corpo antigo) {
    super.didUpdateWidget(antigo);
    if (!identical(antigo.inicial, widget.inicial)) _dados = widget.inicial;
  }

  /// Adota a ficha que a folha devolveu. `null` é quem desistiu.
  void _adotar(PortalMeDataResponse? novos, String aviso) {
    if (novos == null || !mounted) return;
    setState(() => _dados = novos);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(aviso)));
  }

  @override
  Widget build(BuildContext context) {
    final sessao = widget.sessao;
    final petshop = sessao.contexto?.tenant.name ?? 'estabelecimento';

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 36),
      children: [
        _Perfil(
          perfil: _dados.profile,
          petshop: petshop,
          aoEditar: () async => _adotar(
            await abrirEdicaoDoPerfil(context, sessao, _dados.profile),
            'Dados salvos.',
          ),
        ),
        const SizedBox(height: 20),
        _Contato(
          dados: _dados,
          aoAlterar: () async => _adotar(
            await abrirTrocaDeContato(context, sessao, _dados),
            'Contato atualizado.',
          ),
        ),
        const SizedBox(height: 26),
        _Enderecos(
          enderecos: _dados.addresses,
          aoAdicionar: () async => _adotar(
            await abrirFolhaDeEndereco(context, sessao),
            'Endereço salvo.',
          ),
          aoEditar: (endereco) async => _adotar(
            await abrirFolhaDeEndereco(context, sessao, endereco: endereco),
            'Endereço salvo.',
          ),
        ),
        const SizedBox(height: 26),
        _Copia(sessao: sessao, petshop: petshop),
        const SizedBox(height: 20),
        _Exclusao(
          pedido: _dados.deletionRequest,
          petshop: petshop,
          sessao: sessao,
          aoPedir: () async => _adotar(
            await abrirPedidoDeExclusao(context, sessao),
            'Pedido enviado à equipe.',
          ),
        ),
      ],
    );
  }
}

/// "Editar", "Alterar": a ação secundária do cabeçalho de uma seção.
///
/// Pílula neutra, e não texto no acento — a mesma da ficha do pet: na cor da marca ela
/// disputava o olho com o que a tela veio mostrar.
class _AcaoDaSecao extends StatelessWidget {
  const _AcaoDaSecao({required this.rotulo, required this.aoTocar});

  final String rotulo;
  final VoidCallback aoTocar;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return TextButton(
      onPressed: aoTocar,
      style: TextButton.styleFrom(
        foregroundColor: t.tinta,
        backgroundColor: t.chip,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
          side: BorderSide(color: t.linha),
        ),
        textStyle: const TextStyle(
          fontFamily: 'Inter',
          fontSize: 13.5,
          fontWeight: FontWeight.w600,
        ),
      ),
      child: Text(rotulo),
    );
  }
}

/// A frase de rodapé de um cartão, abaixo de um fio.
class _Nota extends StatelessWidget {
  const _Nota(this.texto);

  final String texto;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 14),
        Divider(color: t.linha),
        const SizedBox(height: 10),
        Text(
          texto,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: t.discreta),
        ),
      ],
    );
  }
}

class _Perfil extends StatelessWidget {
  const _Perfil({required this.perfil, required this.petshop, required this.aoEditar});

  final PortalProfile perfil;
  final String petshop;
  final VoidCallback aoEditar;

  @override
  Widget build(BuildContext context) {
    final nascimento = dataDeCalendario(perfil.birthDate);

    return Cartao(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CabecalhoDeSecao(
            icone: Icons.badge_rounded,
            base: Tons.gente,
            titulo: 'Seus dados',
            aDireita: _AcaoDaSecao(rotulo: 'Editar', aoTocar: aoEditar),
          ),
          const SizedBox(height: 12),
          LinhaDeDado(rotulo: 'Nome', valor: perfil.fullName),
          if (perfil.socialName != null && perfil.socialName!.isNotEmpty)
            LinhaDeDado(rotulo: 'Nome social', valor: perfil.socialName!),
          if (perfil.cpfMasked != null) LinhaDeDado(rotulo: 'CPF', valor: perfil.cpfMasked!),
          if (perfil.cnpjMasked != null)
            LinhaDeDado(rotulo: 'CNPJ', valor: perfil.cnpjMasked!),
          if (nascimento != null) LinhaDeDado(rotulo: 'Nascimento', valor: dataCurta(nascimento)),
          // A frase explica a ausência dos campos, em vez de mostrá-los desabilitados.
          _Nota(
            'Nome completo e documento são conferidos no balcão. Se algum estiver errado, '
            'avise o $petshop.',
          ),
        ],
      ),
    );
  }
}

class _Contato extends StatelessWidget {
  const _Contato({required this.dados, required this.aoAlterar});

  final PortalMeDataResponse dados;
  final VoidCallback aoAlterar;

  @override
  Widget build(BuildContext context) {
    final perfil = dados.profile;
    final pendente = dados.pendingContact;

    return Cartao(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CabecalhoDeSecao(
            icone: Icons.phone_rounded,
            titulo: 'Contato',
            aDireita: _AcaoDaSecao(
              rotulo: pendente != null ? 'Confirmar' : 'Alterar',
              aoTocar: aoAlterar,
            ),
          ),
          const SizedBox(height: 12),
          LinhaDeDado(rotulo: 'Telefone', valor: perfil.phoneMasked),
          LinhaDeDado(rotulo: 'E-mail', valor: perfil.email ?? 'Não cadastrado'),
          // O desafio aberto é dito na tela, e não só na folha: quem fechou o app no
          // meio da troca precisa saber que há um código esperando antes de tocar.
          if (pendente != null) ...[
            const SizedBox(height: 10),
            Aviso(
              tom: TomDoAviso.marca,
              icone: Icons.sms_outlined,
              texto: 'Há um código esperando confirmação, enviado para '
                  '${pendente.maskedTarget}.',
            ),
          ],
          const _Nota(
            'Trocar telefone ou e-mail pede um código enviado ao contato novo. É como '
            'sabemos que é você — e é o que impede alguém de apontar o seu cadastro para '
            'outro número.',
          ),
        ],
      ),
    );
  }
}

class _Enderecos extends StatelessWidget {
  const _Enderecos({
    required this.enderecos,
    required this.aoAdicionar,
    required this.aoEditar,
  });

  final List<PortalAddress> enderecos;
  final VoidCallback aoAdicionar;
  final ValueChanged<PortalAddress> aoEditar;

  @override
  Widget build(BuildContext context) {
    final cabecalho = CabecalhoDeSecao(
      icone: Icons.place_rounded,
      base: Tons.tempo,
      titulo: 'Endereços',
      descricao: enderecos.isEmpty
          ? 'Nenhum endereço cadastrado. Ele é usado no leva-e-traz e nas entregas.'
          : null,
      aDireita: _AcaoDaSecao(rotulo: 'Adicionar', aoTocar: aoAdicionar),
    );

    // Sem endereço, a pilha não tem linha nenhuma: o cabeçalho vai num cartão sozinho,
    // com a frase que diz para que ele serve.
    if (enderecos.isEmpty) {
      return Cartao(padding: const EdgeInsets.all(18), child: cabecalho);
    }

    return PilhaDeLinhas(
      cabecalho: cabecalho,
      filhos: [
        for (final e in enderecos)
          Linha(
            inicio: const ChipDeIcone(Icons.place_rounded, tamanho: 40, base: Tons.tempo),
            aoTocar: () => aoEditar(e),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextoDaLinha(
                    titulo: e.label,
                    dica: [
                      '${e.street}, ${e.number}',
                      if (e.complement != null && e.complement!.isNotEmpty) e.complement!,
                    ].join(' — '),
                    // Uma linha de texto, e não pílulas: bairro, cidade e CEP são a
                    // continuação do endereço, e não atributos soltos como espécie e
                    // raça — lidos em pílula, pareceriam etiquetas do lugar.
                    extra: Text(
                      '${e.district} · ${e.city}/${e.state} · ${_cep(e.zipCode)}',
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: context.tokens.discreta),
                    ),
                  ),
                ),
                if (e.isPrimary) ...[
                  const SizedBox(width: 10),
                  const Selo(texto: 'Principal'),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

/// A cópia dos dados (AC-04 — LGPD art. 18, direito de acesso).
///
/// PDF em destaque e JSON discreto, como na web: o JSON é o formato "de leitura por
/// máquina" do art. 19 e não sai da tela, mas quem toca aqui quase nunca é uma máquina.
/// Oferecer os dois com o mesmo peso faria a pessoa escolher no escuro.
class _Copia extends StatefulWidget {
  const _Copia({required this.sessao, required this.petshop});

  final Sessao sessao;
  final String petshop;

  @override
  State<_Copia> createState() => _CopiaState();
}

class _CopiaState extends State<_Copia> {
  /// Qual das duas está sendo preparada — uma de cada vez, e a outra espera.
  String? _baixando;

  Future<void> _baixar(
    String qual,
    Future<ArquivoDoPortal> Function(DateTime hoje) buscar,
  ) async {
    if (_baixando != null) return;

    // O retângulo medido **antes** do `await`: no iPad a folha do sistema é um popover
    // e precisa saber de onde sai.
    final caixa = context.findRenderObject() as RenderBox?;
    final origem = caixa == null || !caixa.hasSize
        ? null
        : caixa.localToGlobal(Offset.zero) & caixa.size;

    setState(() => _baixando = qual);
    try {
      final arquivo = await buscar(widget.sessao.tempo.hoje);
      await entregarArquivo(arquivo, origem: origem);
    } catch (erro) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mensagemDoErro(erro))),
        );
      }
    } finally {
      if (mounted) setState(() => _baixando = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final api = widget.sessao.api;

    return Cartao(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          CabecalhoDeSecao(
            icone: Icons.description_outlined,
            base: Tons.sistema,
            titulo: 'Uma cópia dos seus dados',
            descricao: 'Tudo o que o ${widget.petshop} tem sobre você, num documento só. '
                'É um direito seu, e não precisa de pedido nem de espera.',
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: _baixando != null ? null : () => _baixar('pdf', api.meusDadosEmPdf),
            icon: _baixando == 'pdf'
                ? const Girando(tamanho: 16)
                : const Icon(Icons.picture_as_pdf_rounded, size: 18),
            label: Text(_baixando == 'pdf' ? 'Preparando…' : 'Baixar em PDF'),
          ),
          const SizedBox(height: 6),
          Center(
            child: TextButton(
              onPressed:
                  _baixando != null ? null : () => _baixar('json', api.meusDadosEmJson),
              style: TextButton.styleFrom(foregroundColor: t.discreta),
              child: Text(
                _baixando == 'json'
                    ? 'Preparando…'
                    : 'Prefere o arquivo para outro sistema? Baixar em JSON',
                textAlign: TextAlign.center,
                style: tema.textTheme.bodySmall?.copyWith(
                  color: t.discreta,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// O pedido de exclusão (AC-05).
///
/// **Discreto, e não escondido.** Fica no fim, em texto e não em botão, porque é a ação
/// mais rara e a mais definitiva da tela. Mas está escrito com todas as letras: um
/// direito que só se exerce achando o link não é um direito exercível.
class _Exclusao extends StatelessWidget {
  const _Exclusao({
    required this.pedido,
    required this.petshop,
    required this.sessao,
    required this.aoPedir,
  });

  final PortalDeletionRequest? pedido;
  final String petshop;
  final Sessao sessao;
  final VoidCallback aoPedir;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final t = context.tokens;
    final pedido = this.pedido;
    final aberto = pedido?.status == PortalDeletionRequestStatus.OPEN;

    return Cartao(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const CabecalhoDeSecao(
            icone: Icons.shield_outlined,
            base: Tons.sistema,
            titulo: 'Pedido de exclusão',
          ),
          const SizedBox(height: 14),
          if (pedido != null && aberto)
            Aviso(
              tom: TomDoAviso.marca,
              icone: Icons.hourglass_top_rounded,
              titulo: 'Em análise',
              texto: 'Recebemos seu pedido em ${sessao.tempo.dia(pedido.requestedAt)}. '
                  'O $petshop responde até ${sessao.tempo.dia(pedido.dueAt)}.',
            )
          else ...[
            // O retorno de um pedido anterior continua na tela. Sem ele, quem teve o
            // pedido recusado voltaria a pedir sem nunca saber por quê.
            if (pedido != null) ...[
              Aviso(
                erro: pedido.status == PortalDeletionRequestStatus.REJECTED,
                tom: TomDoAviso.marca,
                icone: Icons.shield_outlined,
                titulo: pedido.status == PortalDeletionRequestStatus.REJECTED
                    ? 'Pedido anterior recusado'
                    : 'Pedido atendido',
                texto: pedido.resolution ?? 'Sem detalhes registrados.',
              ),
              const SizedBox(height: 12),
            ],
            Text(
              'Você pode pedir a exclusão dos seus dados. O pedido vai para a equipe do '
              '$petshop, que responde em até $diasParaResponderExclusao dias — cadastros '
              'com conta em aberto ou documento fiscal em guarda podem não ser apagados '
              'por inteiro.',
              style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
            ),
            const SizedBox(height: 4),
            // Texto sublinhado, e não botão: ação destrutiva não vira a peça de maior
            // contraste da tela, nem fica onde o polegar está salvando outra coisa.
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: aoPedir,
                style: TextButton.styleFrom(
                  foregroundColor: t.fraca,
                  padding: EdgeInsets.zero,
                ),
                child: Text(
                  'Pedir exclusão dos meus dados',
                  style: tema.textTheme.bodyMedium?.copyWith(
                    color: t.fraca,
                    decoration: TextDecoration.underline,
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

String _cep(String valor) =>
    valor.length == 8 ? '${valor.substring(0, 5)}-${valor.substring(5)}' : valor;
