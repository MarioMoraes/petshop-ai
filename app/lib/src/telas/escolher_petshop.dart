import 'package:flutter/material.dart';

import '../auth/sessao.dart';
import '../models/portal_models.dart';
import '../ui/comuns.dart';
import '../ui/dados.dart';
import '../ui/listas.dart';
import '../ui/superficies.dart';

/// A primeira tela: de que petshop se fala.
///
/// Na web esta pergunta não existe — o subdomínio já a responde, e o Next manda o slug
/// ao backend sem que ninguém digite nada. Um aparelho não tem host, então a pergunta
/// volta à superfície. É a única tela do app que não tem equivalente no Portal.
///
/// **Ela era um campo de texto e virou uma lista em 2026-09-21.** Pedir o slug funciona
/// e é ruim: o tutor conhece o petshop pelo nome da fachada, não pelo endereço do site,
/// e quem erra uma letra recebe "não encontramos" sem saber se errou ou se o
/// estabelecimento não usa o app.
///
/// O catálogo vem de `GET /public/v1/portal/tenants` e traz só quem **ligou o Portal do
/// cliente final** — o mesmo critério que a tela seguinte aplica, então nada daqui abre
/// num 404. O filtro é local: a lista inteira já está no aparelho, e ir ao servidor a
/// cada letra só somaria espera.
///
/// O campo de endereço continua existindo, embaixo, para dois casos que a lista não
/// cobre: o petshop que acabou de entrar e ainda está no cache de cinco minutos, e o
/// que prefere não aparecer em catálogo nenhum.
class EscolherPetshop extends StatefulWidget {
  const EscolherPetshop({super.key, required this.sessao});

  final Sessao sessao;

  @override
  State<EscolherPetshop> createState() => _EscolherPetshopState();
}

class _EscolherPetshopState extends State<EscolherPetshop> {
  final _filtro = TextEditingController();
  bool _ocupado = false;

  @override
  void dispose() {
    _filtro.dispose();
    super.dispose();
  }

  Future<void> _escolher(String slug) async {
    setState(() => _ocupado = true);
    await widget.sessao.escolherPetshop(slug);
    if (mounted) setState(() => _ocupado = false);
  }

  @override
  Widget build(BuildContext context) {
    return Tela(
      corpo: SafeArea(
        child: CarregarDados<PortalDirectoryResponse>(
          buscar: widget.sessao.estabelecimentos,
          construir: (context, catalogo, _) {
            final termo = _semAcento(_filtro.text.trim());
            final lista = termo.isEmpty
                ? catalogo.tenants
                : catalogo.tenants
                    .where((item) =>
                        _semAcento(item.name).contains(termo) ||
                        item.slug.contains(termo))
                    .toList();

            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
              children: [
                // A primeira tela do app é a única que não tem marca nenhuma para
                // mostrar — ainda não se sabe de que petshop se fala. O que ela tem é o
                // produto, e é por isso que o título vem na serifa de destaque: é o
                // único momento em que a voz é a da plataforma.
                const TituloDaTela(
                  titulo: 'Qual é o seu petshop?',
                  descricao: 'Escolha o estabelecimento onde o seu pet é atendido.',
                ),
                const SizedBox(height: 22),

                if (catalogo.tenants.isNotEmpty)
                  TextField(
                    controller: _filtro,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      hintText: 'Procurar pelo nome',
                      prefixIcon: Icon(Icons.search),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                const SizedBox(height: 16),

                if (widget.sessao.aviso != null) ...[
                  Aviso(texto: widget.sessao.aviso!, erro: true),
                  const SizedBox(height: 16),
                ],

                if (catalogo.tenants.isEmpty)
                  const EstadoVazio(
                    icone: Icons.storefront_outlined,
                    titulo: 'Nenhum estabelecimento disponível',
                    descricao: 'Nenhum petshop abriu o acesso pelo app ainda. Use o '
                        'endereço que o seu passou para você.',
                  )
                else if (lista.isEmpty)
                  const EstadoVazio(
                    icone: Icons.search_off_outlined,
                    titulo: 'Nada com esse nome',
                    descricao: 'Confira a escrita, ou use o endereço do site que o '
                        'estabelecimento passou para você.',
                  )
                else
                  PilhaDeLinhas(
                    filhos: [
                      for (final item in lista)
                        Linha(
                          // Uma frase só na linha: o nome fica no meio do retrato e da
                          // seta, como no menu do Início.
                          aoCentro: true,
                          inicio: Retrato(
                            nome: item.name,
                            url: item.logoUrl,
                            tamanho: 44,
                          ),
                          aoTocar: _ocupado ? null : () => _escolher(item.slug),
                          // Só o nome. O endereço do site embaixo repetia o nome sem
                          // acento e sem espaço — o tutor reconhece a fachada, não o
                          // slug —, e o filtro continua casando com ele mesmo sem
                          // mostrá-lo. Se um dia dois estabelecimentos tiverem o mesmo
                          // nome, é aqui que a distinção volta.
                          child: TextoDaLinha(titulo: item.name),
                        ),
                    ],
                  ),

                // O aviso só aparece quando é verdade. Uma lista incompleta apresentada
                // como completa é o que faz o tutor concluir que o petshop dele não usa
                // o app — e desistir.
                if (catalogo.truncated) ...[
                  const SizedBox(height: 16),
                  const Aviso(
                    icone: Icons.filter_list_outlined,
                    texto: 'Há mais estabelecimentos do que cabe nesta lista. Se o seu '
                        'não estiver aqui, use o endereço do site dele.',
                  ),
                ],

                const SizedBox(height: 28),
                _PorEndereco(aoEscolher: _escolher, ocupado: _ocupado),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// A porta dos fundos: o endereço digitado.
///
/// Recolhida de propósito. Ela existe para o caso raro — o petshop recém-criado que
/// ainda está no cache do catálogo, ou o que não quer aparecer em lista nenhuma — e
/// deixá-la aberta ao lado da lista devolveria à tela a pergunta que a lista veio
/// responder.
class _PorEndereco extends StatefulWidget {
  const _PorEndereco({required this.aoEscolher, required this.ocupado});

  final Future<void> Function(String slug) aoEscolher;
  final bool ocupado;

  @override
  State<_PorEndereco> createState() => _PorEnderecoState();
}

class _PorEnderecoState extends State<_PorEndereco> {
  final _controle = TextEditingController();
  bool _aberto = false;

  @override
  void dispose() {
    _controle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_aberto) {
      return Center(
        child: TextButton(
          onPressed: () => setState(() => _aberto = true),
          child: const Text('Não achei o meu petshop'),
        ),
      );
    }

    final tema = Theme.of(context);

    return Cartao(
      padding: const EdgeInsets.all(18),
      child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Digite o endereço que o estabelecimento passou para você — é a primeira '
          'parte do site dele.',
          style: tema.textTheme.bodySmall,
        ),
        const SizedBox(height: 12),
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
          onSubmitted: (valor) => widget.aoEscolher(valor.trim()),
        ),
        const SizedBox(height: 12),
        BotaoPrincipal(
          rotulo: 'Continuar',
          ocupado: widget.ocupado,
          rotuloOcupado: 'Procurando…',
          onPressed: () => widget.aoEscolher(_controle.text.trim()),
        ),
      ],
      ),
    );
  }
}

/// Compara sem acento e sem caixa: quem procura "sao" precisa achar "São".
///
/// Tabela à mão, e não `Intl.collator`: o `intl` do Dart não traz normalização Unicode,
/// e as cinco vogais acentuadas do português cabem num mapa que qualquer um lê.
String _semAcento(String texto) {
  const de = 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ';
  const para = 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC';

  final buffer = StringBuffer();
  for (final unidade in texto.toLowerCase().runes) {
    final caractere = String.fromCharCode(unidade);
    final indice = de.indexOf(caractere);
    buffer.write(indice >= 0 ? para[indice] : caractere);
  }
  return buffer.toString().toLowerCase();
}
