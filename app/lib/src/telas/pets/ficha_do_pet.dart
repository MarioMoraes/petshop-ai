import 'package:flutter/material.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import 'editar_pet.dart';
import 'historico.dart';
import 'rotulos.dart';

/// A ficha do pet, com a história dele embaixo (MOD-PORTAL-03 e 04).
///
/// Uma tela só, e não duas com uma aba entre elas: o tutor abre isto para responder
/// "quando foi o último banho?", e a ficha é o cabeçalho dessa resposta, não um destino
/// concorrente. Rolar é mais barato que decidir.
///
/// A ordem — alertas, ficha, histórico — é a da urgência. A alergia é o que muda uma
/// decisão hoje; a data de nascimento não muda nada.
///
/// As duas chamadas saem **juntas**: a ficha e a primeira página do histórico partem
/// antes do primeiro `await`, então a tela custa uma ida ao servidor, e não duas em
/// fila. É a mesma coisa que o `Promise.all` da página da web faz.
class FichaDoPet extends StatefulWidget {
  const FichaDoPet({
    super.key,
    required this.sessao,
    required this.petId,
    required this.nome,
  });

  final Sessao sessao;
  final String petId;

  /// O nome que a lista já sabia — serve de título enquanto a ficha vem, para a tela
  /// não abrir em branco.
  final String nome;

  @override
  State<FichaDoPet> createState() => _FichaDoPetState();
}

class _FichaDoPetState extends State<FichaDoPet> {
  /// Se alguma coisa mudou aqui dentro, quem chamou precisa saber: a lista de pets
  /// mostra o nome, e ele acabou de poder mudar. É o `revalidatePath('/portal/pets')`
  /// da web, dito no vocabulário de quem tem pilha de navegação.
  bool _mudou = false;

  Future<(PortalPetDetail, PortalTimelineResponse)> _buscar() async {
    final ficha = widget.sessao.api.pet(widget.petId);
    final historico = widget.sessao.api.timeline(widget.petId, limite: 10);
    return (await ficha, await historico);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (jaSaiu, _) {
        if (!jaSaiu) Navigator.of(context).pop(_mudou);
      },
      child: Scaffold(
        appBar: AppBar(title: Text(widget.nome)),
        body: CarregarDados<(PortalPetDetail, PortalTimelineResponse)>(
          buscar: _buscar,
          construir: (context, dado, recarregar) {
            final (pet, historico) = dado;
            return _Corpo(
              sessao: widget.sessao,
              pet: pet,
              historico: historico,
              aoSalvar: () async {
                _mudou = true;
                await recarregar();
              },
            );
          },
        ),
      ),
    );
  }
}

class _Corpo extends StatelessWidget {
  const _Corpo({
    required this.sessao,
    required this.pet,
    required this.historico,
    required this.aoSalvar,
  });

  final Sessao sessao;
  final PortalPetDetail pet;
  final PortalTimelineResponse historico;
  final Future<void> Function() aoSalvar;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final nomeDoPetshop = sessao.contexto?.tenant.name ?? 'estabelecimento';
    final grave = pet.alerts.any((a) => a.severity == Severity.CRITICAL);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        Row(
          children: [
            Retrato(nome: pet.name, url: pet.photoUrl, tamanho: 64),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(pet.name,
                      style: tema.textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w700)),
                  Text(
                    descreverPet(
                        especie: pet.species, raca: pet.breed, idade: pet.ageLabel),
                    style: tema.textTheme.bodySmall
                        ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),

        // Pet falecido é somente leitura, e o servidor recusa o PATCH com 404 (AC-05).
        // O botão não aparece — oferecer o que será recusado é pior que não oferecer.
        if (pet.inMemoriam) ...[
          Aviso(
            icone: Icons.pets_outlined,
            texto: 'A ficha do ${pet.name} fica guardada aqui, como está. '
                'Se algo precisar mudar, fale com o $nomeDoPetshop.',
          ),
          const SizedBox(height: 16),
        ],

        if (pet.alerts.isNotEmpty) ...[
          Aviso(
            erro: grave,
            icone: Icons.warning_amber_outlined,
            titulo: 'Atenção no atendimento',
            linhas: pet.alerts.map(rotuloAlerta).toList(),
          ),
          const SizedBox(height: 16),
        ],

        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Expanded(
                      child: CabecalhoDeSecao(
                        icone: Icons.pets_outlined,
                        titulo: 'A ficha',
                      ),
                    ),
                    if (!pet.inMemoriam)
                      TextButton(
                        onPressed: () async {
                          final salvou = await abrirEdicaoDoPet(context, sessao, pet);
                          if (salvou) await aoSalvar();
                        },
                        child: const Text('Editar'),
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                LinhaDeDado(rotulo: 'Sexo', valor: rotuloSexo(pet.sex)),
                LinhaDeDado(
                  rotulo: 'Nascimento',
                  valor: rotuloNascimento(pet.birthDate, pet.birthDatePrecision),
                ),
                LinhaDeDado(rotulo: 'Castrado', valor: rotuloTernario(pet.neutered)),
                LinhaDeDado(rotulo: 'Porte', valor: pet.size),
                LinhaDeDado(rotulo: 'Pelagem', valor: pet.coat ?? '—'),
                LinhaDeDado(rotulo: 'Peso', valor: rotuloPeso(pet.weightKg)),
                if (pet.notes != null && pet.notes!.isNotEmpty)
                  LinhaDeDado(rotulo: 'Observações', valor: pet.notes!),

                // A frase existe porque a tela mostra quatro campos que ela não deixa
                // editar, e um campo travado sem explicação lê como defeito. Dizer por
                // que — e para quem reclamar — é o que separa "não posso" de "não deu".
                const SizedBox(height: 14),
                Divider(color: tema.colorScheme.outlineVariant.withValues(alpha: 0.6)),
                const SizedBox(height: 10),
                Text(
                  'Peso, porte, raça e pelagem são conferidos no balcão, porque entram '
                  'no preço do serviço. Se algum estiver errado, avise o $nomeDoPetshop.',
                  style: tema.textTheme.bodySmall?.copyWith(
                    color: tema.colorScheme.onSurfaceVariant,
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 28),

        Historico(
          sessao: sessao,
          petId: pet.id,
          nome: pet.name,
          inicial: historico,
          tempo: sessao.tempo,
        ),
      ],
    );
  }
}
