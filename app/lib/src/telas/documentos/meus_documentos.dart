import 'package:flutter/material.dart';

import '../../arquivos.dart';
import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/dados.dart';
import '../../ui/folha.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import 'texto_do_termo.dart';

/// Meus documentos (MOD-DOC-10) e os termos que o tutor aceita (MOD-DOC-07 e 08).
///
/// A tradução de `(portal)/portal/documentos`. Duas perguntas, nesta ordem: **o que já é
/// meu** e **o que falta eu aceitar**.
///
/// **A lista é filtrada por titularidade, não por tipo** (AC-03): recibo, receituário e
/// termo aceito saem da mesma tabela e chegam juntos — um tipo novo aparece aqui sem
/// mudar o app.
class MeusDocumentos extends StatelessWidget {
  const MeusDocumentos({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    return Tela(
      appBar: AppBar(title: const Text('Meus documentos')),
      corpo: CarregarDados<(PortalDocumentsResponse, PortalTermsResponse)>(
        buscar: () async {
          final (documentos, termos) = await (
            sessao.api.documentos(),
            sessao.api.termos(),
          ).wait;
          return (documentos, termos);
        },
        construir: (context, dados, recarregar) => ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 36),
          children: [
            _Documentos(sessao: sessao, documentos: dados.$1.documents),
            if (dados.$2.terms.isNotEmpty) ...[
              const SizedBox(height: 26),
              _Termos(sessao: sessao, termos: dados.$2.terms, aoAceitar: recarregar),
            ],
          ],
        ),
      ),
    );
  }
}

const _rotulosDoDocumento = {
  PortalDocumentKind.RECEIPT: 'Recibo',
  PortalDocumentKind.PRESCRIPTION: 'Receituário',
  PortalDocumentKind.TERM_ACCEPTANCE: 'Termo de responsabilidade',
  PortalDocumentKind.IMAGE_CONSENT: 'Autorização de uso de imagem',
};

IconData _iconeDoDocumento(PortalDocumentKind kind) => switch (kind) {
      PortalDocumentKind.RECEIPT => Icons.receipt_long_rounded,
      PortalDocumentKind.PRESCRIPTION => Icons.medication_rounded,
      _ => Icons.description_outlined,
    };

class _Documentos extends StatelessWidget {
  const _Documentos({required this.sessao, required this.documentos});

  final Sessao sessao;
  final List<PortalDocument> documentos;

  @override
  Widget build(BuildContext context) {
    final cabecalho = CabecalhoDeSecao(
      icone: Icons.description_outlined,
      base: Tons.sistema,
      titulo: 'Documentos',
      descricao: documentos.isEmpty
          ? 'Recibos, receituários e termos aceitos aparecem aqui assim que forem emitidos.'
          : null,
    );

    if (documentos.isEmpty) {
      return Cartao(padding: const EdgeInsets.all(18), child: cabecalho);
    }

    return PilhaDeLinhas(
      cabecalho: cabecalho,
      filhos: [
        for (final documento in documentos)
          _LinhaDoDocumento(sessao: sessao, documento: documento),
      ],
    );
  }
}

/// Uma linha da lista, que abre o PDF no toque.
///
/// São **duas** idas ao servidor, como no recibo: a primeira pede o endereço assinado —
/// e é esse pedido que a trilha registra como download —, a segunda é o navegador do
/// aparelho buscando o arquivo.
///
/// **O documento em preparo aparece sem seta**, e não some: quem acabou de pagar precisa
/// ver que o recibo está a caminho, em vez de concluir que ele não existe.
class _LinhaDoDocumento extends StatefulWidget {
  const _LinhaDoDocumento({required this.sessao, required this.documento});

  final Sessao sessao;
  final PortalDocument documento;

  @override
  State<_LinhaDoDocumento> createState() => _LinhaDoDocumentoState();
}

class _LinhaDoDocumentoState extends State<_LinhaDoDocumento> {
  bool _abrindo = false;

  Future<void> _abrir() async {
    if (_abrindo) return;
    setState(() => _abrindo = true);

    try {
      final url = await widget.sessao.api.enderecoDoDocumento(widget.documento.id);
      if (!mounted) return;

      // A lista dizia "pronto", mas o arquivo ainda não está no bucket: o PDF nasce
      // fora da transação, e a lista pode ter sido lida um instante antes.
      if (url == null) {
        _dizer('O documento está sendo gerado. Tente de novo em alguns instantes.');
        return;
      }

      final abriu = await abrirEndereco(Uri.parse(url));
      if (!mounted || abriu) return;
      _dizer('Não foi possível abrir o documento neste aparelho.');
    } catch (erro) {
      if (mounted) _dizer(mensagemDoErro(erro));
    } finally {
      if (mounted) setState(() => _abrindo = false);
    }
  }

  void _dizer(String texto) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(texto)));
  }

  @override
  Widget build(BuildContext context) {
    final documento = widget.documento;
    final t = context.tokens;

    return Linha(
      aoCentro: true,
      inicio: _abrindo
          ? const SizedBox(width: 44, height: 44, child: Center(child: Girando(tamanho: 18)))
          : ChipDeIcone(_iconeDoDocumento(documento.kind), base: Tons.sistema),
      aoTocar: documento.ready && !_abrindo ? _abrir : null,
      child: Row(
        children: [
          Expanded(
            child: TextoDaLinha(
              titulo: _rotulosDoDocumento[documento.kind]!,
              dica: [
                'Nº ${documento.number}',
                if (documento.issuedAt != null) widget.sessao.tempo.dia(documento.issuedAt!),
                ?documento.petName,
              ].join(' · '),
            ),
          ),
          if (!documento.ready) ...[
            const SizedBox(width: 10),
            Text(
              'em preparo',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: t.discreta),
            ),
          ],
        ],
      ),
    );
  }
}

const _rotulosDoTermo = {
  PortalTermKind.TERMS: 'Termos de uso e privacidade',
  PortalTermKind.SERVICE_LIABILITY: 'Termo de responsabilidade',
  PortalTermKind.IMAGE_USE: 'Autorização de uso de imagem',
};

/// Os termos, do lado de quem assina.
///
/// **O texto abre numa folha, e o aceite mora nela.** Um "aceito" na linha, ao lado de
/// um texto que ninguém abriu, colheria consentimento de quem não leu — e é o texto que
/// dá valor à prova.
class _Termos extends StatelessWidget {
  const _Termos({required this.sessao, required this.termos, required this.aoAceitar});

  final Sessao sessao;
  final List<PortalTerm> termos;
  final Future<void> Function() aoAceitar;

  @override
  Widget build(BuildContext context) {
    return PilhaDeLinhas(
      cabecalho: const CabecalhoDeSecao(
        icone: Icons.verified_user_outlined,
        base: Tons.sistema,
        titulo: 'Termos',
      ),
      filhos: [
        for (final termo in termos)
          Linha(
            aoCentro: true,
            inicio: ChipDeIcone(
              termo.accepted ? Icons.task_alt_rounded : Icons.edit_document,
              base: Tons.sistema,
            ),
            aoTocar: () async {
              final aceitou = await abrirFolha<bool>(
                context,
                (_) => _FolhaDoTermo(sessao: sessao, termo: termo),
              );
              if (aceitou != true || !context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Aceite registrado.')),
              );
              await aoAceitar();
            },
            child: TextoDaLinha(
              titulo: _rotulosDoTermo[termo.kind]!,
              dica: termo.accepted
                  ? 'Aceito · versão ${termo.version}'
                  : termo.acceptedVersion != null
                      ? 'Você aceitou a versão ${termo.acceptedVersion}; há uma nova'
                      : 'Ainda não aceito',
            ),
          ),
      ],
    );
  }
}

/// A folha do termo: o texto inteiro e, quando falta aceitar, "Li e aceito".
///
/// Termo aceito na versão vigente abre só para leitura: oferecer "aceitar de novo"
/// produziria um 409 do servidor para um toque que a tela convidou a dar.
class _FolhaDoTermo extends StatefulWidget {
  const _FolhaDoTermo({required this.sessao, required this.termo});

  final Sessao sessao;
  final PortalTerm termo;

  @override
  State<_FolhaDoTermo> createState() => _FolhaDoTermoState();
}

class _FolhaDoTermoState extends State<_FolhaDoTermo> {
  bool _enviando = false;
  String? _erro;

  Future<void> _aceitar() async {
    setState(() {
      _enviando = true;
      _erro = null;
    });
    try {
      await widget.sessao.api.aceitarTermo(widget.termo.kind);
      if (mounted) Navigator.of(context).pop(true);
    } catch (erro) {
      if (mounted) {
        setState(() {
          _enviando = false;
          _erro = mensagemDoErro(erro);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final termo = widget.termo;
    final titulo = _rotulosDoTermo[termo.kind]!;
    final descricao = 'Versão ${termo.version}';

    if (!termo.accepted) {
      return FolhaDeFormulario(
        icone: Icons.edit_document,
        base: Tons.sistema,
        titulo: titulo,
        descricao: descricao,
        rotuloDaAcao: 'Li e aceito',
        rotuloOcupado: 'Registrando…',
        ocupado: _enviando,
        erro: _erro,
        aoConfirmar: _aceitar,
        filhos: [TextoDoTermo(corpo: termo.body)],
      );
    }

    final tema = Theme.of(context);
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, 8, 20, 24 + MediaQuery.paddingOf(context).bottom),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const ChipDeIcone(Icons.task_alt_rounded, tamanho: 40, base: Tons.sistema),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(titulo, style: tema.textTheme.titleLarge),
                    const SizedBox(height: 3),
                    Text('Aceito · $descricao', style: tema.textTheme.bodySmall),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          TextoDoTermo(corpo: termo.body),
        ],
      ),
    );
  }
}
