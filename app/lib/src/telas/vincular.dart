import 'package:flutter/material.dart';

import '../api/portal_error.dart';
import '../auth/sessao.dart';
import '../models/portal_models.dart';
import '../ui/comuns.dart';

/// Ligar esta conta à ficha que o petshop já tem.
///
/// Tradução de `portal/vincular/link-form.tsx`. Duas decisões de lá atravessam sem
/// mudança, porque são de produto e não de plataforma:
///
/// **A tela não diz se o contato foi encontrado.** A resposta do backend é idêntica para
/// quem é cliente e para quem não é (RN-04) — 202 com o mesmo corpo e o mesmo tempo —,
/// porque o contrário transformaria o app num consultor de "fulano é cliente daqui?",
/// consultável por qualquer um sobre qualquer pessoa. Quem digitou errado descobre no
/// passo dois, quando o código não chega.
///
/// **Há uma saída.** Quem entrou com a conta errada não tem ficha para vincular e não
/// tem para onde ir — toda outra tela exige justamente o vínculo que falta. Sem o "usar
/// outra conta", a tela é uma armadilha.
///
/// O honeypot da web não vem junto: lá ele é um campo de verdade no HTML, que separa
/// gente de robô que varre formulário. Aqui não há formulário a varrer, e um campo
/// invisível num app seria só cerimônia.
class Vincular extends StatefulWidget {
  const Vincular({super.key, required this.sessao});

  final Sessao sessao;

  @override
  State<Vincular> createState() => _VincularState();
}

class _VincularState extends State<Vincular> {
  final _contato = TextEditingController();
  final _codigo = TextEditingController();

  bool _ocupado = false;
  String? _erro;
  PortalChallengeResponse? _desafio;

  @override
  void dispose() {
    _contato.dispose();
    _codigo.dispose();
    super.dispose();
  }

  Future<void> _executar(Future<void> Function() acao) async {
    setState(() {
      _ocupado = true;
      _erro = null;
    });
    try {
      await acao();
    } on PortalError catch (e) {
      if (mounted) setState(() => _erro = e.message);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _pedirCodigo() => _executar(() async {
        final contato = _contato.text.trim();
        if (contato.isEmpty) return;
        final resposta = await widget.sessao.api
            .pedirCodigo(PortalChallenge(identifier: contato, website: null));
        if (mounted) setState(() => _desafio = resposta);
      });

  Future<void> _confirmar() => _executar(() async {
        final desafio = _desafio;
        if (desafio == null) return;
        await widget.sessao.api.confirmarCodigo(
          PortalVerify(challengeId: desafio.challengeId, code: _codigo.text),
        );
        await widget.sessao.revalidar();
      });

  @override
  Widget build(BuildContext context) {
    final tenant = widget.sessao.tenant;
    final desafio = _desafio;

    if (desafio != null) {
      return MolduraDeEntrada(
        nomeDoPetshop: tenant?.name,
        titulo: 'Digite o código',
        descricao: 'Enviamos um código de 6 dígitos para ${desafio.maskedTarget}. '
            'Ele vale por ${desafio.expiresInMin} minutos.',
        aoVoltar: () => setState(() {
          _desafio = null;
          _codigo.clear();
          _erro = null;
        }),
        filhos: [
          TextField(
            controller: _codigo,
            autofocus: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 24, letterSpacing: 10),
            decoration: const InputDecoration(counterText: ''),
            onChanged: (v) {
              if (v.length == 6) _confirmar();
            },
          ),
          if (_erro != null) ...[
            const SizedBox(height: 8),
            Aviso(texto: _erro!, erro: true),
          ],
          const SizedBox(height: 20),
          BotaoPrincipal(
            rotulo: 'Confirmar',
            ocupado: _ocupado,
            rotuloOcupado: 'Confirmando…',
            onPressed: _codigo.text.length < 6 ? null : _confirmar,
          ),
        ],
      );
    }

    return MolduraDeEntrada(
      nomeDoPetshop: tenant?.name,
      titulo: 'Encontre o seu cadastro',
      descricao: 'Informe o e-mail ou o telefone que você já deu ao estabelecimento.',
      filhos: [
        TextField(
          controller: _contato,
          autofocus: true,
          autocorrect: false,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(
            hintText: 'E-mail ou telefone',
            prefixIcon: Icon(Icons.badge_outlined),
          ),
          onSubmitted: (_) => _pedirCodigo(),
        ),
        if (_erro != null) ...[
          const SizedBox(height: 16),
          Aviso(texto: _erro!, erro: true),
        ],
        const SizedBox(height: 16),
        const Aviso(
          icone: Icons.verified_user_outlined,
          texto: 'O acesso é criado sobre o cadastro que o estabelecimento já tem. '
              'Se o contato não for encontrado, o código não chega — e aí é com eles '
              'que você fala.',
        ),
        const SizedBox(height: 20),
        BotaoPrincipal(
          rotulo: 'Enviar código',
          ocupado: _ocupado,
          rotuloOcupado: 'Enviando…',
          onPressed: _pedirCodigo,
        ),
        const SizedBox(height: 12),
        TextButton(
          onPressed: _ocupado ? null : widget.sessao.sair,
          child: const Text('Entrar com outra conta'),
        ),
      ],
    );
  }
}
