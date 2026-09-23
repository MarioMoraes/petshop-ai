import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/dados.dart';
import '../../ui/folha.dart';

/// A troca de telefone ou e-mail, em dois passos (AC-02 de MOD-PORTAL-09).
///
/// **Uma folha, duas vistas.** A pessoa sai do app para ler a mensagem e volta; se o
/// segundo passo fosse outra tela, voltar exigiria refazer o caminho.
///
/// **A vista do código abre sozinha quando há um pedido pendente** — o servidor devolve
/// o desafio aberto em `pendingContact` para isso: quem fechou o app no meio da
/// verificação encontra o campo do código, e não um formulário vazio.
///
/// Uma divergência da web: aqui a seta de voltar existe **também** com o desafio que veio
/// do servidor. Pedir um código novo invalida o anterior (`contact-change.ts`), então
/// não há estado a proteger — e quem digitou o número errado e fechou o app ficaria
/// preso a ele por dez minutos.
///
/// O que a folha **não** faz: aplicar a mudança antes do código.
Future<PortalMeDataResponse?> abrirTrocaDeContato(
  BuildContext context,
  Sessao sessao,
  PortalMeDataResponse dados,
) =>
    abrirFolha<PortalMeDataResponse>(
      context,
      (_) => _TrocaDeContato(sessao: sessao, dados: dados),
    );

class _TrocaDeContato extends StatefulWidget {
  const _TrocaDeContato({required this.sessao, required this.dados});

  final Sessao sessao;
  final PortalMeDataResponse dados;

  @override
  State<_TrocaDeContato> createState() => _TrocaDeContatoState();
}

/// O desafio em curso: para onde o código foi.
class _Desafio {
  const _Desafio(this.id, this.destino);

  final String id;
  final String destino;
}

class _TrocaDeContatoState extends State<_TrocaDeContato> {
  late PortalContactField _campo =
      widget.dados.pendingContact?.field ?? PortalContactField.PHONE;
  late _Desafio? _desafio = switch (widget.dados.pendingContact) {
    final p? => _Desafio(p.id, p.maskedTarget),
    null => null,
  };

  final _valor = TextEditingController();
  final _codigo = TextEditingController();

  bool _ocupado = false;
  String? _erro;

  @override
  void dispose() {
    _valor.dispose();
    _codigo.dispose();
    super.dispose();
  }

  Future<void> _pedirCodigo() async {
    setState(() {
      _ocupado = true;
      _erro = null;
    });
    try {
      final resposta = await widget.sessao.api.pedirTrocaDeContato(
        PortalContactChange(field: _campo, value: _valor.text.trim()),
      );
      if (!mounted) return;
      setState(() {
        _desafio = _Desafio(resposta.changeId, resposta.maskedTarget);
        _codigo.clear();
      });
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _confirmar() async {
    final desafio = _desafio;
    if (desafio == null) return;

    setState(() {
      _ocupado = true;
      _erro = null;
    });
    try {
      final dados = await widget.sessao.api.confirmarTrocaDeContato(
        PortalContactVerify(changeId: desafio.id, code: _codigo.text),
      );
      if (mounted) Navigator.of(context).pop(dados);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  void _voltarParaOValor() => setState(() {
        _desafio = null;
        _codigo.clear();
        _erro = null;
      });

  @override
  Widget build(BuildContext context) {
    final desafio = _desafio;
    return desafio == null ? _vistaDoValor() : _vistaDoCodigo(desafio);
  }

  Widget _vistaDoValor() {
    final perfil = widget.dados.profile;
    final telefone = _campo == PortalContactField.PHONE;

    return FolhaDeFormulario(
      icone: Icons.phone_rounded,
      titulo: 'Alterar contato',
      descricao: 'Enviaremos um código para o contato novo antes de trocar.',
      rotuloDaAcao: 'Enviar código',
      rotuloOcupado: 'Enviando…',
      ocupado: _ocupado,
      aoConfirmar: _valor.text.trim().length < 5 ? null : _pedirCodigo,
      erro: _erro,
      filhos: [
        SegmentedButton<PortalContactField>(
          segments: const [
            ButtonSegment(value: PortalContactField.PHONE, label: Text('Telefone')),
            ButtonSegment(value: PortalContactField.EMAIL, label: Text('E-mail')),
          ],
          selected: {_campo},
          showSelectedIcon: false,
          onSelectionChanged: _ocupado
              ? null
              : (escolha) => setState(() {
                    _campo = escolha.first;
                    _valor.clear();
                    _erro = null;
                  }),
        ),
        const SizedBox(height: 18),
        RotuloDeCampo(telefone ? 'Telefone novo' : 'E-mail novo'),
        TextField(
          // A chave troca com o campo: sem ela o Flutter reaproveitaria o mesmo campo, e
          // o teclado numérico continuaria aberto para quem acabou de escolher e-mail.
          key: ValueKey(_campo),
          controller: _valor,
          maxLength: 160,
          keyboardType: telefone ? TextInputType.phone : TextInputType.emailAddress,
          autofillHints: [telefone ? AutofillHints.telephoneNumber : AutofillHints.email],
          autocorrect: false,
          decoration: InputDecoration(
            counterText: '',
            hintText: telefone ? '(11) 98765-4321' : 'voce@exemplo.com',
          ),
          onChanged: (_) => setState(() {}),
        ),
        DicaDeCampo(
          telefone
              ? 'Hoje: ${perfil.phoneMasked}. Informe DDD e número.'
              : perfil.email != null
                  ? 'Hoje: ${perfil.email}'
                  : 'Você ainda não tem e-mail cadastrado.',
        ),
      ],
    );
  }

  Widget _vistaDoCodigo(_Desafio desafio) {
    final rotulo = _campo == PortalContactField.PHONE ? 'telefone' : 'e-mail';

    return FolhaDeFormulario(
      icone: Icons.phone_rounded,
      titulo: 'Confirme o código',
      descricao: 'Enviamos um código para ${desafio.destino}. Ele vale por 10 minutos.',
      aoVoltar: _voltarParaOValor,
      rotuloDaAcao: 'Confirmar',
      rotuloOcupado: 'Confirmando…',
      ocupado: _ocupado,
      aoConfirmar: _codigo.text.length == 6 ? _confirmar : null,
      erro: _erro,
      filhos: [
        const RotuloDeCampo('Código de 6 dígitos'),
        TextField(
          controller: _codigo,
          autofocus: true,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(6),
          ],
          style: const TextStyle(letterSpacing: 6, fontSize: 20),
          onChanged: (_) => setState(() {}),
        ),
        DicaDeCampo('Não recebeu? Volte, confira o $rotulo digitado e peça de novo.'),
      ],
    );
  }
}
