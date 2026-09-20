import 'package:flutter/material.dart';

import 'auth/sessao.dart';
import 'telas/entrar.dart';
import 'telas/escolher_petshop.dart';
import 'telas/vincular.dart';
import 'ui/comuns.dart';
import 'ui/tema.dart';

/// A raiz do app.
///
/// Não há roteador de rotas nomeadas aqui, e isso é deliberado: **as telas de entrada
/// não são lugares aonde se navega, são estados em que se está.** Quem não escolheu
/// petshop não pode "voltar" para os pets; quem não vinculou a ficha não tem para onde
/// ir. Um `Navigator` com pilha daria a impressão contrária e abriria caminhos que o
/// backend responderia com 401.
///
/// Quem manda é `Sessao.estado`, e ele muda por `revalidar()`, que pergunta ao servidor
/// em vez de deduzir.
class App extends StatefulWidget {
  const App({super.key});

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> {
  final _sessao = Sessao();

  @override
  void initState() {
    super.initState();
    _sessao.iniciar();
  }

  @override
  void dispose() {
    _sessao.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _sessao,
      builder: (context, _) {
        final brilho = MediaQuery.platformBrightnessOf(context);
        return MaterialApp(
          title: 'Meu Petshop',
          debugShowCheckedModeBanner: false,
          theme: temaDoPetshop(_sessao.tenant?.brandColor, brilho),
          home: _tela(),
        );
      },
    );
  }

  Widget _tela() => switch (_sessao.estado) {
        EstadoDaSessao.carregando =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
        EstadoDaSessao.semPetshop => EscolherPetshop(sessao: _sessao),
        EstadoDaSessao.semConta => Entrar(sessao: _sessao),
        EstadoDaSessao.semVinculo => Vincular(sessao: _sessao),
        EstadoDaSessao.pronta => _Inicio(sessao: _sessao),
      };
}

/// Marca-lugar da etapa 3.
///
/// Mostra o que a sessão já sabe — é o que torna a etapa 2 verificável de ponta a ponta
/// sem esperar as telas de pets.
class _Inicio extends StatelessWidget {
  const _Inicio({required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final contexto = sessao.contexto!;
    final tema = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(contexto.tenant.name),
        actions: [
          IconButton(
            tooltip: 'Sair',
            onPressed: sessao.sair,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text('Olá, ${contexto.tutor.name}',
              style: tema.textTheme.headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text(
            '${contexto.tutor.petsCount} pet(s) · fuso ${contexto.tenant.timezone}',
            style: tema.textTheme.bodyMedium
                ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 24),
          const Aviso(
            icone: Icons.construction_outlined,
            texto: 'Etapa 2 concluída: petshop escolhido, conta na Clerk e ficha '
                'vinculada. As telas de pets, agendamentos e agendar vêm nas próximas.',
          ),
          const SizedBox(height: 24),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('O que este estabelecimento tem ligado',
                      style: tema.textTheme.titleSmall),
                  const SizedBox(height: 12),
                  _Recurso('Agendamento online',
                      contexto.features.onlineBookingEnabled),
                  _Recurso('Aprovação do pedido',
                      contexto.features.onlineBookingRequiresApproval),
                  _Recurso('Leva e traz', contexto.features.taxiEnabled),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: sessao.trocarPetshop,
            child: const Text('Trocar de estabelecimento'),
          ),
        ],
      ),
    );
  }
}

class _Recurso extends StatelessWidget {
  const _Recurso(this.nome, this.ligado);

  final String nome;
  final bool ligado;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(ligado ? Icons.check_circle : Icons.remove_circle_outline,
              size: 18,
              color: ligado ? esquema.primary : esquema.onSurfaceVariant),
          const SizedBox(width: 10),
          Text(nome),
        ],
      ),
    );
  }
}
