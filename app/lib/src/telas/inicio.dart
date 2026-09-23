import 'package:flutter/material.dart';

import '../auth/sessao.dart';
import '../ui/listas.dart';
import '../ui/superficies.dart';
import '../ui/tema.dart';
import 'agendamentos/lista_de_agendamentos.dart';
import 'agendar/marcar_horario.dart';
import 'dados/meus_dados.dart';
import 'financeiro/minha_conta.dart';
import 'pets/lista_de_pets.dart';

/// O Início do app: quem é o tutor aqui, e por onde se entra.
///
/// **Uma ação e um menu**, e não uma pilha de botões — é a decisão do Portal na web, e
/// aqui ela ganhou forma: a ação mora no painel escuro do topo, junto da saudação, e os
/// destinos ficam embaixo, em linhas. Enquanto "Marcar horário" era mais um item da
/// mesma lista, ele lia como o item selecionado, e não como o que se veio fazer.
///
/// O menu é curto de propósito. Cada linha que existe leva a algo que funciona — o que
/// ainda não foi construído não vira item cinza que aceita o toque e não faz nada, e o
/// que falta também não é anunciado aqui: a primeira tela do app não é lugar para falar
/// do que ele não tem.
///
/// **O leva-e-traz não ganhou linha própria**, ainda que o app agora o peça: no MOD-TAXI
/// o dono da corrida é o agendamento, e uma entrada aqui prometeria um pedido solto que
/// não existe. Ele mora dentro de "Marcar horário", e quem já tem corrida pedida a vê no
/// agendamento, que é onde ela acontece.
///
/// **As linhas não têm legenda**, também a pedido do usuário: "Meus pets" já diz o que
/// há do outro lado, e a segunda linha explicando que ali estão a ficha e o histórico
/// dobrava a altura do menu para repetir o nome com outras palavras.
///
/// **"Trocar de estabelecimento" saiu desta tela**, a pedido. A saída continua
/// existindo — sair pelo botão do painel devolve à tela de entrada, que oferece a
/// troca —, e o caso é raro o bastante para não gastar uma linha do Início: quem leva o
/// pet em dois petshops é exceção, e quem leva em um nunca precisou daquele botão.
class Inicio extends StatelessWidget {
  const Inicio({super.key, required this.sessao});

  final Sessao sessao;

  @override
  Widget build(BuildContext context) {
    final contexto = sessao.contexto!;
    final tema = Theme.of(context);
    final t = context.tokens;

    return Tela(
      // O painel escuro já é o foco do topo; o brilho da marca atrás dele viraria uma
      // segunda fonte de luz na mesma dobra.
      brilho: false,
      corpo: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                children: [
            PainelEscuro(
              padding: const EdgeInsets.fromLTRB(22, 20, 22, 22),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          contexto.tenant.name.toUpperCase(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: tema.textTheme.labelMedium?.copyWith(
                            color: Colors.white.withValues(alpha: 0.62),
                          ),
                        ),
                      ),
                      _AcaoDoPainel(
                        icone: Icons.logout_rounded,
                        dica: 'Sair',
                        aoTocar: sessao.sair,
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'Olá, ${contexto.tutor.name}',
                    style: tema.textTheme.headlineMedium?.copyWith(
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    // Plural por extenso, e não "pet(s)": a saudação é a primeira frase
                    // que o app diz ao tutor, e parêntese de formulário ali soa a
                    // sistema, não a lugar que cuida do cachorro dele.
                    contexto.tutor.petsCount == 1
                        ? '1 pet cadastrado'
                        : '${contexto.tutor.petsCount} pets cadastrados',
                    style: tema.textTheme.bodySmall?.copyWith(
                      color: Colors.white.withValues(alpha: 0.72),
                    ),
                  ),

                  /// **O botão lê `features`, e não uma constante.**
                  ///
                  /// É assim que o app degrada sozinho num estabelecimento que não
                  /// recebe agendamento pelo site: a porta não aparece, em vez de abrir
                  /// numa tela que responderia 403.
                  if (contexto.features.onlineBookingEnabled) ...[
                    const SizedBox(height: 20),
                    _BotaoClaro(
                      rotulo: 'Marcar horário',
                      icone: Icons.add_rounded,
                      aoTocar: () => Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => MarcarHorario(sessao: sessao),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 26),

            PilhaDeLinhas(
              filhos: [
                Linha(
                  aoCentro: true,
                  inicio: const ChipDeIcone(Icons.pets_rounded, base: Tons.pet),
                  aoTocar: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => ListaDePets(sessao: sessao)),
                  ),
                  child: const TextoDaLinha(titulo: 'Meus pets'),
                ),

                /// Esta não depende de `features`: ver o que já está marcado vale
                /// mesmo no estabelecimento que não recebe agendamento pelo app — foi a
                /// recepção que marcou, e o tutor continua querendo saber quando é.
                Linha(
                  aoCentro: true,
                  inicio: const ChipDeIcone(
                    Icons.calendar_month_rounded,
                    base: Tons.tempo,
                  ),
                  aoTocar: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => ListaDeAgendamentos(sessao: sessao),
                    ),
                  ),
                  child: const TextoDaLinha(titulo: 'Meus agendamentos'),
                ),

                /// "Minha conta", e não "Financeiro": o nome do módulo é vocabulário de
                /// quem opera o petshop. O que o tutor procura aqui é a conta **dele**.
                ///
                /// Também não depende de `features`: a conta existe em todo
                /// estabelecimento, inclusive no que não recebe agendamento pelo app —
                /// quem foi atendido no balcão tem lançamento para conferir do mesmo
                /// jeito.
                Linha(
                  aoCentro: true,
                  inicio: const ChipDeIcone(
                    Icons.account_balance_wallet_rounded,
                    base: Tons.dinheiro,
                  ),
                  aoTocar: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => MinhaConta(sessao: sessao)),
                  ),
                  child: const TextoDaLinha(titulo: 'Minha conta'),
                ),

                /// Por último, porque é o destino menos frequente — corrigir um
                /// endereço, trocar o telefone. Mas não sai do menu: é também onde mora
                /// o pedido de exclusão, e um direito que só se acha procurando não é
                /// um direito exercível (e as lojas exigem o caminho dentro do app).
                Linha(
                  aoCentro: true,
                  inicio: const ChipDeIcone(Icons.badge_rounded, base: Tons.gente),
                  aoTocar: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => MeusDados(sessao: sessao)),
                  ),
                  child: const TextoDaLinha(titulo: 'Meus dados'),
                ),
              ],
            ),
                ],
              ),
            ),

            // A assinatura do produto fica **fora** da lista, presa ao pé da tela.
            //
            // Dentro dela, era o último item de uma rolagem que nem sempre rola: num
            // celular alto o menu acabava no meio do vazio e a assinatura ficava
            // pendurada no meio da tela. Fora, ela é o chão — e o `SafeArea` da `Tela`
            // garante que não encoste na barra do sistema.
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 12),
              child: Text(
                'PETSHOP AI',
                style: tema.textTheme.labelMedium?.copyWith(
                  color: t.discreta.withValues(alpha: 0.75),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A ação clara sobre o painel escuro.
///
/// O `BotaoPrincipal` não serve aqui: ele é escuro, e escuro sobre escuro é um buraco.
/// A regra do design do produto — a ação que grava é a peça de maior contraste da tela —
/// continua valendo; o que muda é para que lado fica o contraste.
class _BotaoClaro extends StatelessWidget {
  const _BotaoClaro({
    required this.rotulo,
    required this.aoTocar,
    required this.icone,
  });

  final String rotulo;
  final IconData icone;
  final VoidCallback aoTocar;

  @override
  Widget build(BuildContext context) {
    final forma = BorderRadius.circular(Raio.acao);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: forma,
        boxShadow: const [
          BoxShadow(
            color: Color(0x33000000),
            blurRadius: 18,
            spreadRadius: -6,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: aoTocar,
          borderRadius: forma,
          child: SizedBox(
            height: 50,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icone, size: 20, color: const Color(0xFF17181A)),
                const SizedBox(width: 8),
                Text(
                  rotulo,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 15.5,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF17181A),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// O botão de ícone do painel: um alvo de 40px com fundo de vidro.
///
/// Ícone solto sobre o grafite tem alvo pequeno demais e nenhuma resposta ao toque — e
/// "Sair" é justamente o botão que ninguém quer tocar por engano nem tocar duas vezes.
class _AcaoDoPainel extends StatelessWidget {
  const _AcaoDoPainel({
    required this.icone,
    required this.dica,
    required this.aoTocar,
  });

  final IconData icone;
  final String dica;
  final VoidCallback aoTocar;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: dica,
      child: Material(
        color: Colors.white.withValues(alpha: 0.10),
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: aoTocar,
          child: SizedBox(
            width: 40,
            height: 40,
            child: Icon(
              icone,
              size: 19,
              color: Colors.white.withValues(alpha: 0.86),
            ),
          ),
        ),
      ),
    );
  }
}
