import 'package:flutter/material.dart';

import '../auth/sessao.dart';
import '../ui/comuns.dart';
import '../ui/listas.dart';
import 'agendamentos/lista_de_agendamentos.dart';
import 'agendar/marcar_horario.dart';
import 'pets/lista_de_pets.dart';

/// O Início do app: quem é o tutor aqui, e por onde se entra.
///
/// O menu é curto de propósito. Cada linha que existe leva a algo que funciona — o que
/// ainda não foi construído não vira item cinza que aceita o toque e não faz nada. O
/// aviso embaixo diz o que falta, e é honesto sobre isso.
class Inicio extends StatelessWidget {
  const Inicio({super.key, required this.sessao});

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
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          Text('Olá, ${contexto.tutor.name}',
              style: tema.textTheme.headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(
            '${contexto.tutor.petsCount} pet(s) cadastrado(s)',
            style: tema.textTheme.bodyMedium
                ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: 24),
          PilhaDeLinhas(
            filhos: [
              Linha(
                inicio: _Icone(Icons.pets_outlined),
                aoTocar: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => ListaDePets(sessao: sessao)),
                ),
                child: const TextoDaLinha(
                  titulo: 'Meus pets',
                  dica: 'A ficha e o histórico de cada um',
                ),
              ),

              /// Esta não depende de `features`: ver o que já está marcado vale
              /// mesmo no estabelecimento que não recebe agendamento pelo app — foi a
              /// recepção que marcou, e o tutor continua querendo saber quando é.
              Linha(
                inicio: _Icone(Icons.event_outlined),
                aoTocar: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => ListaDeAgendamentos(sessao: sessao),
                  ),
                ),
                child: const TextoDaLinha(
                  titulo: 'Meus agendamentos',
                  dica: 'Os próximos horários e o histórico',
                ),
              ),

              /// **A linha lê `features`, e não uma constante.**
              ///
              /// É assim que o app degrada sozinho num estabelecimento que não recebe
              /// agendamento pelo site: a porta não aparece, em vez de abrir numa tela
              /// que responderia 403.
              if (contexto.features.onlineBookingEnabled)
                Linha(
                  inicio: _Icone(Icons.calendar_month_outlined),
                  aoTocar: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => MarcarHorario(sessao: sessao)),
                  ),
                  child: const TextoDaLinha(
                    titulo: 'Marcar horário',
                    dica: 'Banho, tosa e o que mais o petshop oferecer',
                  ),
                ),
            ],
          ),
          const SizedBox(height: 24),
          const Aviso(
            icone: Icons.local_shipping_outlined,
            texto: 'O leva-e-traz continua no Portal do Tutor pelo navegador: aqui o '
                'app mostra as corridas já pedidas, mas ainda não pede novas.',
          ),
          const SizedBox(height: 24),
          TextButton(
            onPressed: sessao.trocarPetshop,
            child: const Text('Trocar de estabelecimento'),
          ),
        ],
      ),
    );
  }
}

class _Icone extends StatelessWidget {
  const _Icone(this.icone);

  final IconData icone;

  @override
  Widget build(BuildContext context) {
    final esquema = Theme.of(context).colorScheme;
    return Container(
      width: 40,
      height: 40,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: esquema.primaryContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Icon(icone, size: 20, color: esquema.onPrimaryContainer),
    );
  }
}
