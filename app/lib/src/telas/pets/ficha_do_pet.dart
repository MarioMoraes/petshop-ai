import 'package:flutter/material.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
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
      child: Tela(
        appBar: AppBar(title: Text(widget.nome)),
        corpo: CarregarDados<(PortalPetDetail, PortalTimelineResponse)>(
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
    final t = context.tokens;
    final nomeDoPetshop = sessao.contexto?.tenant.name ?? 'estabelecimento';
    final grave = pet.alerts.any((a) => a.severity == Severity.CRITICAL);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 36),
      children: [
        // O retrato grande abre a tela: o tutor veio ver o **pet dele**, e o nome em
        // cima de uma foto de 80px diz isso antes de qualquer campo.
        Cartao(
          padding: const EdgeInsets.all(18),
          child: Row(
            children: [
              Retrato(nome: pet.name, url: pet.photoUrl, tamanho: 80),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(pet.name, style: tema.textTheme.headlineSmall),
                    const SizedBox(height: 4),
                    Text(
                      descreverPet(
                          especie: pet.species, raca: pet.breed, idade: pet.ageLabel),
                      style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
                    ),
                    if (pet.inMemoriam) ...[
                      const SizedBox(height: 10),
                      const Selo(texto: 'Em memória', icone: Icons.favorite_rounded),
                    ],
                  ],
                ),
              ),
            ],
          ),
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
            // O grave é vermelho; o resto é âmbar, e não cinza: a alergia não impede
            // nada, mas precisa ser vista antes do resto da ficha.
            erro: grave,
            tom: TomDoAviso.atencao,
            icone: Icons.warning_amber_rounded,
            titulo: 'Atenção no atendimento',
            linhas: pet.alerts.map(rotuloAlerta).toList(),
          ),
          const SizedBox(height: 16),
        ],

        Cartao(
          padding: const EdgeInsets.all(18),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CabecalhoDeSecao(
                  icone: Icons.badge_outlined,
                  titulo: 'A ficha',
                  base: Tons.pet,
                  // Pílula neutra, e não texto no acento: "Editar" é ação secundária, e
                  // na cor da marca ela disputava o olho com o que a tela veio mostrar.
                  aDireita: pet.inMemoriam
                      ? null
                      : TextButton(
                          onPressed: () async {
                            final salvou = await abrirEdicaoDoPet(context, sessao, pet);
                            if (salvou) await aoSalvar();
                          },
                          style: TextButton.styleFrom(
                            foregroundColor: t.tinta,
                            backgroundColor: t.chip,
                            padding: const EdgeInsets.symmetric(
                                horizontal: 16, vertical: 8),
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
                          child: const Text('Editar'),
                        ),
                ),
                const SizedBox(height: 12),
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

              ],
          ),
        ),
        const SizedBox(height: 30),

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
