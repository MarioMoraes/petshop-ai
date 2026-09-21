import 'package:flutter/material.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../time/tenant_time.dart';
import '../../ui/dados.dart';
import '../../ui/listas.dart';
import '../../ui/superficies.dart';
import '../../ui/tema.dart';
import 'ficha_do_pet.dart';

/// "Meus pets" (MOD-PORTAL-03).
///
/// O que cada linha mostra saiu da pergunta que o tutor faz ao abrir isto: **quando é o
/// próximo, e quando foi o último**. Espécie, raça e idade servem só para reconhecer de
/// qual pet se trata quando há mais de um; nada além disso cabe aqui.
///
/// O pet falecido continua na lista, numa seção "Em memória" (AC-05). Ele não some
/// porque a história dele não sumiu — o transferido, esse sim sai, mas não por decisão
/// desta tela: ele sai porque o vínculo terminou e o servidor não o devolve mais.
class ListaDePets extends StatelessWidget {
  const ListaDePets({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    return Tela(
      appBar: AppBar(title: const Text('Meus pets')),
      corpo: CarregarDados<List<PortalPetSummary>>(
        buscar: sessao.api.pets,
        construir: (context, pets, _) => _Lista(sessao: sessao, pets: pets),
      ),
    );
  }
}

class _Lista extends StatelessWidget {
  const _Lista({required this.sessao, required this.pets});

  final Sessao sessao;
  final List<PortalPetSummary> pets;

  @override
  Widget build(BuildContext context) {
    final vivos = pets.where((p) => !p.inMemoriam).toList();
    final emMemoria = pets.where((p) => p.inMemoriam).toList();
    final tempo = sessao.tempo;
    final nomeDoPetshop = sessao.contexto?.tenant.name ?? 'estabelecimento';

    return ListView(
      // `always` para que o puxar-para-atualizar funcione mesmo com a lista curta
      // demais para rolar — que é justamente o caso de quem tem um pet só.
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 36),
      children: [
        if (pets.isEmpty)
          EstadoVazio(
            icone: Icons.pets_outlined,
            titulo: 'Nenhum pet por aqui ainda',
            descricao: 'Quem cadastra os pets é o $nomeDoPetshop. '
                'Se algum estiver faltando, fale com eles.',
          ),
        if (vivos.isNotEmpty)
          PilhaDeLinhas(
            filhos: [
              for (final pet in vivos)
                _LinhaDePet(sessao: sessao, pet: pet, tempo: tempo),
            ],
          ),
        if (emMemoria.isNotEmpty) ...[
          if (vivos.isNotEmpty) const SizedBox(height: 30),
          PilhaDeLinhas(
            cabecalho: const CabecalhoDeSecao(
              icone: Icons.favorite_rounded,
              base: Tons.pet,
              titulo: 'Em memória',
              descricao: 'A ficha e o histórico continuam aqui.',
            ),
            filhos: [
              for (final pet in emMemoria)
                _LinhaDePet(sessao: sessao, pet: pet, tempo: tempo),
            ],
          ),
        ],
      ],
    );
  }
}

class _LinhaDePet extends StatelessWidget {
  const _LinhaDePet({required this.sessao, required this.pet, required this.tempo});

  final Sessao sessao;
  final PortalPetSummary pet;
  final TenantTime tempo;

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);
    final proximo = pet.nextAppointment;

    // A terceira linha é a única aqui que muda de peso: o compromisso marcado vem em
    // texto de leitura, o atendimento passado desce ao cinza da legenda.
    final t = context.tokens;

    Widget? extra;
    if (proximo != null) {
      // O compromisso marcado ganha a cor da marca e um fundo próprio: numa lista de
      // três linhas cinzentas, ele é a única que muda o que o tutor faz hoje.
      // **Uma linha só, e o que não couber é o serviço.**
      //
      // A pílula tinha três informações de comprimento livre — "Próximo", a data e os
      // serviços — e quebrava em duas linhas no aparelho, com a segunda começando num
      // pedaço de palavra. Agora a data, que é o que decide, vem em peso e não quebra;
      // o serviço vai depois e é ele quem perde a ponta, porque é o detalhe que a tela
      // do agendamento mostra inteiro.
      extra = Container(
        padding: const EdgeInsets.fromLTRB(9, 6, 11, 6),
        decoration: BoxDecoration(
          color: t.acentoSuave,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: t.acentoAro),
        ),
        child: Row(
          children: [
            Icon(Icons.event_rounded, size: 14, color: t.acentoTinta),
            const SizedBox(width: 7),
            Flexible(
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(
                    // Dia e hora, sem o ano: o próximo compromisso é sempre das
                    // próximas semanas, e o ano empurrava a pílula para duas linhas.
                    // A data inteira continua em Meus agendamentos.
                    text: '${tempo.diaCurto(proximo.startsAt)} às '
                        '${tempo.hora(proximo.startsAt)}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  if (proximo.services.isNotEmpty)
                    TextSpan(
                      text: ' · ${proximo.services.join(', ')}',
                      style: TextStyle(color: t.acentoTinta.withValues(alpha: 0.78)),
                    ),
                ]),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: tema.textTheme.bodySmall
                    ?.copyWith(color: t.acentoTinta, fontSize: 12.5, height: 1.3),
              ),
            ),
          ],
        ),
      );
    } else if (pet.lastAttendanceAt != null) {
      extra = Text(
        'Último atendimento em ${tempo.diaCurto(pet.lastAttendanceAt!)}',
        style: tema.textTheme.bodySmall?.copyWith(color: t.discreta),
      );
    }

    return Linha(
      inicio: Retrato(nome: pet.name, url: pet.photoUrl, tamanho: 52),
      aoTocar: () => Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => FichaDoPet(sessao: sessao, petId: pet.id, nome: pet.name),
        ),
      ),
      child: TextoDaLinha(
        titulo: pet.name,
        meta: [pet.species, pet.breed, pet.ageLabel],
        extra: extra,
      ),
    );
  }
}
