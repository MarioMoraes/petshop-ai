import 'package:flutter/material.dart';

import '../auth/sessao.dart';
import '../ui/comuns.dart';

/// A primeira tela: de que petshop se fala.
///
/// Na web esta pergunta não existe — o subdomínio já a responde, e o Next manda o slug
/// ao backend sem que ninguém digite nada. Um aparelho não tem host, então a pergunta
/// volta à superfície. É a única tela do app que não tem equivalente no Portal.
///
/// Quem valida é `GET /portal/v1/tenant`, que é anônimo: ele confirma o endereço e já
/// traz a marca, então a tela seguinte abre com a cara do estabelecimento certo.
class EscolherPetshop extends StatefulWidget {
  const EscolherPetshop({super.key, required this.sessao});

  final Sessao sessao;

  @override
  State<EscolherPetshop> createState() => _EscolherPetshopState();
}

class _EscolherPetshopState extends State<EscolherPetshop> {
  final _controle = TextEditingController();
  bool _ocupado = false;

  @override
  void dispose() {
    _controle.dispose();
    super.dispose();
  }

  Future<void> _confirmar() async {
    final valor = _controle.text.trim();
    if (valor.isEmpty) return;
    setState(() => _ocupado = true);
    await widget.sessao.escolherPetshop(valor);
    if (mounted) setState(() => _ocupado = false);
  }

  @override
  Widget build(BuildContext context) {
    final aviso = widget.sessao.aviso;

    return MolduraDeEntrada(
      titulo: 'Qual é o seu petshop?',
      descricao: 'Digite o endereço que o estabelecimento passou para você — é a '
          'primeira parte do site dele.',
      filhos: [
        TextField(
          controller: _controle,
          autofocus: true,
          autocorrect: false,
          textCapitalization: TextCapitalization.none,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            hintText: 'petshopdojoao',
            prefixIcon: Icon(Icons.storefront_outlined),
          ),
          onSubmitted: (_) => _confirmar(),
        ),
        if (aviso != null) ...[
          const SizedBox(height: 16),
          Aviso(texto: aviso, erro: true),
        ],
        const SizedBox(height: 20),
        BotaoPrincipal(
          rotulo: 'Continuar',
          ocupado: _ocupado,
          rotuloOcupado: 'Procurando…',
          onPressed: _confirmar,
        ),
      ],
    );
  }
}
