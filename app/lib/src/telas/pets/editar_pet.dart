import 'package:flutter/material.dart';

import '../../api/portal_error.dart';
import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';

/// A edição da ficha pelo tutor (AC-02 de MOD-PORTAL-03).
///
/// É folha inferior, e não uma tela `/editar`: o formulário responde a **um** registro
/// que já está na tela — a mesma regra que manda a web usar `<Modal>` aqui. Fica colado
/// no rodapé, com os botões na largura toda, que é onde o polegar alcança.
///
/// **Quatro campos, e o motivo de serem quatro é o schema.** Peso, porte, raça e pelagem
/// entram no preço do serviço, então não estão aqui — nem desabilitados. Campo
/// desabilitado num formulário é convite a tentar; o que não se edita fica na ficha,
/// como leitura, com a frase que explica por quê.
///
/// Devolve `true` quando gravou.
Future<bool> abrirEdicaoDoPet(
  BuildContext context,
  Sessao sessao,
  PortalPetDetail pet,
) async {
  final salvou = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => _FormularioDoPet(sessao: sessao, pet: pet),
  );
  return salvou ?? false;
}

class _FormularioDoPet extends StatefulWidget {
  const _FormularioDoPet({required this.sessao, required this.pet});

  final Sessao sessao;
  final PortalPetDetail pet;

  @override
  State<_FormularioDoPet> createState() => _FormularioDoPetState();
}

enum _Castrado { sim, nao, naoSei }

class _FormularioDoPetState extends State<_FormularioDoPet> {
  late final _nome = TextEditingController(text: widget.pet.name);
  late final _observacoes = TextEditingController(text: widget.pet.notes ?? '');
  late DateTime? _nascimento = _dataDe(widget.pet.birthDate);
  late _Castrado _castrado = switch (widget.pet.neutered) {
    true => _Castrado.sim,
    false => _Castrado.nao,
    null => _Castrado.naoSei,
  };

  bool _salvando = false;
  String? _erro;

  @override
  void dispose() {
    _nome.dispose();
    _observacoes.dispose();
    super.dispose();
  }

  /// `2021-03-10` → `DateTime` local, sem hora.
  ///
  /// Sem fuso de propósito: data de nascimento é **dia de calendário**, e não um
  /// instante. Passar por UTC aqui é como se perde um dia inteiro a cada ida e volta.
  static DateTime? _dataDe(String? iso) {
    if (iso == null || iso.isEmpty) return null;
    final partes = iso.split('-');
    if (partes.length != 3) return null;
    final ano = int.tryParse(partes[0]);
    final mes = int.tryParse(partes[1]);
    final dia = int.tryParse(partes[2]);
    if (ano == null || mes == null || dia == null) return null;
    return DateTime(ano, mes, dia);
  }

  Future<void> _escolherData() async {
    final hoje = widget.sessao.tempo.hoje;
    final escolhida = await showDatePicker(
      context: context,
      initialDate: _nascimento ?? hoje,
      firstDate: DateTime(hoje.year - 30),
      // Não há pet nascido amanhã, e a data futura viraria idade negativa na ficha.
      lastDate: hoje,
    );
    if (escolhida != null) setState(() => _nascimento = escolhida);
  }

  Future<void> _salvar() async {
    final nome = _nome.text.trim();
    if (nome.isEmpty) return;

    setState(() {
      _salvando = true;
      _erro = null;
    });

    try {
      /// Os quatro campos vão **sempre**, e os nulos vão junto.
      ///
      /// Esta é a exceção do `semNulos`: aqui `null` é o "apague" de quem limpou o
      /// campo, e omitir manteria o valor antigo — o formulário fecharia dizendo que
      /// salvou, com a data errada intacta. `name` nunca é nulo porque o botão não
      /// deixa gravar com o campo vazio.
      final mudanca = UpdateOwnPet(
        name: nome,
        birthDate: _nascimento,
        neutered: switch (_castrado) {
          _Castrado.sim => true,
          _Castrado.nao => false,
          _Castrado.naoSei => null,
        },
        notes: _observacoes.text.trim().isEmpty ? null : _observacoes.text.trim(),
      );

      await widget.sessao.api.atualizarPet(widget.pet.id, mudanca);
      if (mounted) Navigator.of(context).pop(true);
    } on PortalError catch (e) {
      // A mensagem do 422 vem do serviço e não é reescrita: os textos de `ERR_PORTAL_*`
      // já foram escritos para o cliente final, e uma segunda cópia envelheceria só.
      if (mounted) setState(() => _erro = e.message);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _salvando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tema = Theme.of(context);

    return Padding(
      // O teclado sobe por cima da folha; sem isto, o campo em foco fica embaixo dele.
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Dados do ${widget.pet.name}',
                style: tema.textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(
              'Peso, porte, raça e pelagem são atualizados pelo estabelecimento.',
              style: tema.textTheme.bodySmall
                  ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 20),

            _Rotulo('Nome'),
            TextField(
              controller: _nome,
              maxLength: 60,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 16),

            _Rotulo('Data de nascimento'),
            InkWell(
              onTap: _salvando ? null : _escolherData,
              borderRadius: BorderRadius.circular(14),
              child: InputDecorator(
                decoration: InputDecoration(
                  // Limpar é o caminho de volta ao "não sei", e o schema tem um jeito de
                  // dizer isso: `null`. Sem o botão, quem errou o ano fica preso a ele.
                  suffixIcon: _nascimento == null
                      ? const Icon(Icons.calendar_today_outlined, size: 20)
                      : IconButton(
                          tooltip: 'Limpar',
                          icon: const Icon(Icons.close, size: 20),
                          onPressed:
                              _salvando ? null : () => setState(() => _nascimento = null),
                        ),
                ),
                child: Text(
                  _nascimento == null
                      ? 'Não informado'
                      : '${_doisDigitos(_nascimento!.day)}/'
                          '${_doisDigitos(_nascimento!.month)}/${_nascimento!.year}',
                  style: TextStyle(
                    color: _nascimento == null
                        ? tema.colorScheme.onSurfaceVariant
                        : tema.colorScheme.onSurface,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Se não souber o dia exato, deixe em branco — o estabelecimento estima '
              'pela idade.',
              style: tema.textTheme.bodySmall
                  ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),

            _Rotulo('Castrado'),
            SegmentedButton<_Castrado>(
              segments: const [
                ButtonSegment(value: _Castrado.sim, label: Text('Sim')),
                ButtonSegment(value: _Castrado.nao, label: Text('Não')),
                ButtonSegment(value: _Castrado.naoSei, label: Text('Não sei')),
              ],
              selected: {_castrado},
              showSelectedIcon: false,
              onSelectionChanged: _salvando
                  ? null
                  : (escolha) => setState(() => _castrado = escolha.first),
            ),
            const SizedBox(height: 16),

            _Rotulo('Observações'),
            TextField(
              controller: _observacoes,
              maxLength: 500,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
            ),
            Text(
              'O que ajuda quem vai atender: manias, medos, o que acalma.',
              style: tema.textTheme.bodySmall
                  ?.copyWith(color: tema.colorScheme.onSurfaceVariant),
            ),

            if (_erro != null) ...[
              const SizedBox(height: 16),
              Aviso(texto: _erro!, erro: true),
            ],

            const SizedBox(height: 20),
            BotaoPrincipal(
              rotulo: 'Salvar',
              rotuloOcupado: 'Salvando…',
              ocupado: _salvando,
              onPressed: _nome.text.trim().isEmpty ? null : _salvar,
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _salvando ? null : () => Navigator.of(context).pop(false),
              child: const Text('Cancelar'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Rotulo extends StatelessWidget {
  const _Rotulo(this.texto);

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        texto,
        style: Theme.of(context)
            .textTheme
            .labelLarge
            ?.copyWith(fontWeight: FontWeight.w600),
      ),
    );
  }
}

String _doisDigitos(int valor) => valor.toString().padLeft(2, '0');
