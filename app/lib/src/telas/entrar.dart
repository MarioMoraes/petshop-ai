import 'package:flutter/material.dart';

import '../auth/clerk_fapi.dart';
import '../auth/sessao.dart';
import '../ui/comuns.dart';

/// Entrar e criar conta pela **mesma porta**.
///
/// A decisão vem do Portal web (`portal/entrar/page.tsx`): o tutor não sabe se "já tem
/// cadastro". O cadastro que ele conhece é a ficha que o petshop tem dele — e essa é a
/// etapa seguinte, o vínculo. Aqui ele digita o e-mail, e quem descobre se a conta
/// existe é o app: `form_identifier_not_found` não é erro a mostrar, é o sinal de que a
/// senha precisa ser pedida para criar o acesso.
///
/// A senha aparece só nesse caso, e só porque **esta instância da Clerk a exige** no
/// cadastro. De entrada em diante o caminho é sempre o código no e-mail.
class Entrar extends StatefulWidget {
  const Entrar({super.key, required this.sessao});

  final Sessao sessao;

  @override
  State<Entrar> createState() => _EntrarState();
}

enum _Passo { email, senha, codigo }

class _EntrarState extends State<Entrar> {
  final _email = TextEditingController();
  final _senha = TextEditingController();
  final _codigo = TextEditingController();

  _Passo _passo = _Passo.email;
  bool _ocupado = false;
  String? _erro;

  /// O `sia_…` de uma entrada ou o `sua_…` de um cadastro em curso.
  String? _tentativa;

  /// Qual dos dois caminhos está em voo — é o que decide qual rota confirma o código.
  bool _criandoConta = false;

  String _destino = '';

  @override
  void dispose() {
    _email.dispose();
    _senha.dispose();
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
    } on ClerkErro catch (e) {
      if (mounted) setState(() => _erro = e.mensagem);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _continuarComEmail() => _executar(() async {
        final email = _email.text.trim();
        if (email.isEmpty) return;
        try {
          final passo = await widget.sessao.clerk.entrarComEmail(email);
          if (!mounted) return;
          setState(() {
            _criandoConta = false;
            _tentativa = passo.tentativaId;
            _destino = passo.destino ?? email;
            _passo = _Passo.codigo;
          });
        } on ClerkErro catch (e) {
          if (!e.contaNaoEncontrada) rethrow;
          // Não há conta: a porta é a mesma, o passo seguinte é criá-la.
          if (!mounted) return;
          setState(() => _passo = _Passo.senha);
        }
      });

  Future<void> _criarConta() => _executar(() async {
        final passo = await widget.sessao.clerk
            .criarConta(_email.text.trim(), _senha.text);
        if (!mounted) return;
        setState(() {
          _criandoConta = true;
          _tentativa = passo.tentativaId;
          _destino = passo.destino ?? _email.text.trim();
          _passo = _Passo.codigo;
        });
      });

  Future<void> _confirmarCodigo() => _executar(() async {
        final id = _tentativa;
        if (id == null) return;
        final passo = _criandoConta
            ? await widget.sessao.clerk.confirmarConta(id, _codigo.text)
            : await widget.sessao.clerk.confirmarEntrada(id, _codigo.text);
        if (passo.sessaoId != null) {
          await widget.sessao.concluiuLogin(passo.sessaoId!);
        }
      });

  void _voltarAoEmail() {
    setState(() {
      _passo = _Passo.email;
      _codigo.clear();
      _senha.clear();
      _erro = null;
      _tentativa = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final tenant = widget.sessao.tenant;
    final nome = tenant?.name;

    return switch (_passo) {
      _Passo.email => MolduraDeEntrada(
          nomeDoPetshop: nome,
          logoUrl: tenant?.logoUrl,
          titulo: 'Acompanhe seus pets',
          descricao: 'Entre com o e-mail que você já usa no estabelecimento.',
          filhos: [
            TextField(
              controller: _email,
              autofocus: true,
              autocorrect: false,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                hintText: 'voce@exemplo.com',
                prefixIcon: Icon(Icons.alternate_email),
              ),
              onSubmitted: (_) => _continuarComEmail(),
            ),
            if (_erro != null) ...[
              const SizedBox(height: 16),
              Aviso(texto: _erro!, erro: true),
            ],
            const SizedBox(height: 20),
            BotaoPrincipal(
              rotulo: 'Continuar',
              ocupado: _ocupado,
              rotuloOcupado: 'Verificando…',
              onPressed: _continuarComEmail,
            ),
            const SizedBox(height: 20),
            TextButton(
              onPressed: _ocupado ? null : widget.sessao.trocarPetshop,
              child: const Text('Trocar de estabelecimento'),
            ),
          ],
        ),
      _Passo.senha => MolduraDeEntrada(
          nomeDoPetshop: nome,
          logoUrl: tenant?.logoUrl,
          titulo: 'Crie o seu acesso',
          descricao: 'Ainda não há conta com ${_email.text.trim()}. '
              'Escolha uma senha e enviaremos um código para confirmar o e-mail.',
          aoVoltar: _voltarAoEmail,
          filhos: [
            TextField(
              controller: _senha,
              autofocus: true,
              obscureText: true,
              decoration: const InputDecoration(
                hintText: 'Sua senha',
                prefixIcon: Icon(Icons.lock_outline),
              ),
              onSubmitted: (_) => _criarConta(),
            ),
            if (_erro != null) ...[
              const SizedBox(height: 16),
              Aviso(texto: _erro!, erro: true),
            ],
            const SizedBox(height: 20),
            BotaoPrincipal(
              rotulo: 'Criar acesso',
              ocupado: _ocupado,
              rotuloOcupado: 'Criando…',
              onPressed: _criarConta,
            ),
          ],
        ),
      _Passo.codigo => MolduraDeEntrada(
          nomeDoPetshop: nome,
          logoUrl: tenant?.logoUrl,
          titulo: 'Digite o código',
          descricao: 'Enviamos um código de 6 dígitos para $_destino.',
          aoVoltar: _voltarAoEmail,
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
                if (v.length == 6) _confirmarCodigo();
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
              onPressed: _codigo.text.length < 6 ? null : _confirmarCodigo,
            ),
          ],
        ),
    };
  }
}
