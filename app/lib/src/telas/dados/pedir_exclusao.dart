import 'package:flutter/material.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/dados.dart';
import '../../ui/folha.dart';

/// Prazo legal de resposta (LGPD art. 19, II) — `PORTAL_DELETION_RESPONSE_DAYS` em
/// `shared-types/portal.ts`. É constante do TypeScript, e não schema, então o gerador de
/// modelos não a alcança; a folha só a repete na frase, e quem calcula o prazo de verdade
/// é o servidor, no `dueAt` que desce com o pedido.
const diasParaResponderExclusao = 15;

/// O pedido de exclusão dos dados (LGPD art. 18, V — AC-05 de MOD-PORTAL-09).
///
/// **A folha promete o que o sistema cumpre.** Não diz "seus dados serão apagados": diz
/// que o pedido vai para a equipe e que a resposta vem em até quinze dias. O petshop pode
/// ter nota fiscal em prazo de guarda e conta em aberto, e aí a resposta é uma recusa
/// fundamentada.
///
/// É também o que as lojas pedem de um app que cria conta: um caminho, dentro dele, para
/// pedir a exclusão.
Future<PortalMeDataResponse?> abrirPedidoDeExclusao(
  BuildContext context,
  Sessao sessao,
) =>
    abrirFolha<PortalMeDataResponse>(context, (_) => _PedidoDeExclusao(sessao: sessao));

class _PedidoDeExclusao extends StatefulWidget {
  const _PedidoDeExclusao({required this.sessao});

  final Sessao sessao;

  @override
  State<_PedidoDeExclusao> createState() => _PedidoDeExclusaoState();
}

class _PedidoDeExclusaoState extends State<_PedidoDeExclusao> {
  final _motivo = TextEditingController();

  bool _enviando = false;
  String? _erro;

  @override
  void dispose() {
    _motivo.dispose();
    super.dispose();
  }

  Future<void> _enviar() async {
    setState(() {
      _enviando = true;
      _erro = null;
    });
    try {
      final motivo = _motivo.text.trim();
      final dados = await widget.sessao.api.pedirExclusao(
        PortalDeletionRequestInput(reason: motivo.isEmpty ? null : motivo),
      );
      if (mounted) Navigator.of(context).pop(dados);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final petshop = widget.sessao.contexto?.tenant.name ?? 'estabelecimento';
    final tema = Theme.of(context);

    return FolhaDeFormulario(
      icone: Icons.shield_outlined,
      titulo: 'Pedir exclusão dos dados',
      descricao: 'A equipe do $petshop responde em até $diasParaResponderExclusao dias.',
      rotuloDaAcao: 'Enviar pedido',
      rotuloOcupado: 'Enviando…',
      ocupado: _enviando,
      aoConfirmar: _enviar,
      erro: _erro,
      filhos: [
        Text(
          'Nada é apagado agora. Seus agendamentos e sua conta seguem como estão até a '
          'equipe responder.',
          style: tema.textTheme.bodyMedium,
        ),
        const SizedBox(height: 18),
        const RotuloDeCampo('Quer contar o motivo?'),
        TextField(
          controller: _motivo,
          maxLength: 500,
          maxLines: 3,
          textCapitalization: TextCapitalization.sentences,
        ),
        const DicaDeCampo(
          'Opcional. Às vezes o que incomoda se resolve sem apagar nada — desligar as '
          'promoções, por exemplo.',
        ),
      ],
    );
  }
}
