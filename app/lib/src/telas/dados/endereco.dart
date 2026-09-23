import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/comuns.dart';
import '../../ui/dados.dart';
import '../../ui/folha.dart';

/// O endereço, cadastrado ou corrigido pelo titular (AC-01).
///
/// Uma folha para os dois casos: os campos são os mesmos, e a única diferença é o verbo.
///
/// **Sem latitude e longitude**, nem escondidas: quem geocodifica é o MOD-TAXI, e aceitar
/// coordenadas do cliente deixaria o tutor mover o ponto de coleta da van para qualquer
/// lugar do mapa sem mudar uma letra do endereço. O servidor recusa; a folha nem oferece.
Future<PortalMeDataResponse?> abrirFolhaDeEndereco(
  BuildContext context,
  Sessao sessao, {
  PortalAddress? endereco,
}) =>
    abrirFolha<PortalMeDataResponse>(
      context,
      (_) => _FormularioDoEndereco(sessao: sessao, endereco: endereco),
    );

class _FormularioDoEndereco extends StatefulWidget {
  const _FormularioDoEndereco({required this.sessao, this.endereco});

  final Sessao sessao;
  final PortalAddress? endereco;

  @override
  State<_FormularioDoEndereco> createState() => _FormularioDoEnderecoState();
}

class _FormularioDoEnderecoState extends State<_FormularioDoEndereco> {
  late final PortalAddress? _original = widget.endereco;

  late final _apelido = TextEditingController(text: _original?.label ?? '');
  late final _cep = TextEditingController(text: _cepFormatado(_original?.zipCode ?? ''));
  late final _rua = TextEditingController(text: _original?.street ?? '');
  late final _numero = TextEditingController(text: _original?.number ?? '');
  late final _complemento = TextEditingController(text: _original?.complement ?? '');
  late final _bairro = TextEditingController(text: _original?.district ?? '');
  late final _cidade = TextEditingController(text: _original?.city ?? '');
  late final _uf = TextEditingController(text: _original?.state ?? '');
  late final _acesso = TextEditingController(text: _original?.accessNotes ?? '');

  /// O primeiro endereço nasce principal: exigir o toque deixaria a ficha com um
  /// endereço e nenhum principal, o estado que o leva-e-traz não sabe resolver.
  late bool _principal = _original?.isPrimary ?? true;

  bool _salvando = false;
  String? _erro;

  List<TextEditingController> get _campos =>
      [_apelido, _cep, _rua, _numero, _complemento, _bairro, _cidade, _uf, _acesso];

  @override
  void dispose() {
    for (final c in _campos) {
      c.dispose();
    }
    super.dispose();
  }

  String get _cepDigitos => _cep.text.replaceAll(RegExp(r'\D'), '');

  /// O mínimo que o schema exige, conferido antes de gastar uma ida ao servidor. O
  /// resto — CEP que não existe, UF inválida — é o 422 do servidor que diz.
  bool get _completo =>
      _cepDigitos.length == 8 &&
      _rua.text.trim().length >= 3 &&
      _numero.text.trim().isNotEmpty &&
      _bairro.text.trim().isNotEmpty &&
      _cidade.text.trim().isNotEmpty &&
      _uf.text.trim().length == 2;

  Future<void> _salvar() async {
    setState(() {
      _salvando = true;
      _erro = null;
    });

    final apelido = _apelido.text.trim().isEmpty ? 'Casa' : _apelido.text.trim();
    final complemento = _complemento.text.trim();
    final acesso = _acesso.text.trim();

    try {
      final original = _original;
      final dados = original == null
          ? await widget.sessao.api.adicionarEndereco(
              PortalAddressInput(
                label: apelido,
                zipCode: _cepDigitos,
                street: _rua.text.trim(),
                number: _numero.text.trim(),
                complement: complemento.isEmpty ? null : complemento,
                district: _bairro.text.trim(),
                city: _cidade.text.trim(),
                state: _uf.text.trim().toUpperCase(),
                accessNotes: acesso.isEmpty ? null : acesso,
                isPrimary: _principal,
              ),
            )
          : await widget.sessao.api.corrigirEndereco(
              original.id,
              UpdatePortalAddress(
                label: apelido,
                zipCode: _cepDigitos,
                street: _rua.text.trim(),
                number: _numero.text.trim(),
                // String vazia, e não `null`, é o "apague" destes dois: no schema eles
                // são `.optional()`, e `null` seria 422. Mandar vazio só quando havia
                // algo evita escrever na trilha uma mudança que ninguém fez.
                complement: complemento.isEmpty
                    ? ((original.complement ?? '').isEmpty ? null : '')
                    : complemento,
                district: _bairro.text.trim(),
                city: _cidade.text.trim(),
                state: _uf.text.trim().toUpperCase(),
                accessNotes: acesso.isEmpty
                    ? ((original.accessNotes ?? '').isEmpty ? null : '')
                    : acesso,
                isPrimary: _principal,
              ),
            );
      if (mounted) Navigator.of(context).pop(dados);
    } catch (e) {
      if (mounted) setState(() => _erro = mensagemDoErro(e));
    } finally {
      if (mounted) setState(() => _salvando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    void mudou(String _) => setState(() {});

    return FolhaDeFormulario(
      icone: Icons.place_rounded,
      titulo: _original == null ? 'Novo endereço' : 'Corrigir endereço',
      descricao: 'É por ele que a van encontra você no leva-e-traz.',
      rotuloDaAcao: 'Salvar',
      rotuloOcupado: 'Salvando…',
      ocupado: _salvando,
      aoConfirmar: _completo ? _salvar : null,
      erro: _erro,
      filhos: [
        const RotuloDeCampo('Apelido'),
        TextField(
          controller: _apelido,
          maxLength: 40,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(counterText: '', hintText: 'Casa'),
        ),
        const DicaDeCampo('Casa, trabalho, casa da minha mãe…'),
        const SizedBox(height: 16),
        const RotuloDeCampo('CEP'),
        TextField(
          controller: _cep,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.postalCode],
          inputFormatters: [_MascaraDeCep()],
          decoration: const InputDecoration(hintText: '00000-000'),
          onChanged: mudou,
        ),
        const SizedBox(height: 16),
        const RotuloDeCampo('Rua'),
        TextField(
          controller: _rua,
          maxLength: 160,
          textCapitalization: TextCapitalization.words,
          autofillHints: const [AutofillHints.streetAddressLine1],
          decoration: const InputDecoration(counterText: ''),
          onChanged: mudou,
        ),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const RotuloDeCampo('Número'),
                  TextField(
                    controller: _numero,
                    maxLength: 20,
                    decoration: const InputDecoration(counterText: ''),
                    onChanged: mudou,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const RotuloDeCampo('Complemento'),
                  TextField(
                    controller: _complemento,
                    maxLength: 80,
                    decoration: const InputDecoration(counterText: ''),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        const RotuloDeCampo('Bairro'),
        TextField(
          controller: _bairro,
          maxLength: 80,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(counterText: ''),
          onChanged: mudou,
        ),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const RotuloDeCampo('Cidade'),
                  TextField(
                    controller: _cidade,
                    maxLength: 80,
                    textCapitalization: TextCapitalization.words,
                    autofillHints: const [AutofillHints.addressCity],
                    decoration: const InputDecoration(counterText: ''),
                    onChanged: mudou,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              width: 84,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const RotuloDeCampo('UF'),
                  TextField(
                    controller: _uf,
                    textCapitalization: TextCapitalization.characters,
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp('[A-Za-z]')),
                      LengthLimitingTextInputFormatter(2),
                    ],
                    onChanged: mudou,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        const RotuloDeCampo('Como chegar'),
        TextField(
          controller: _acesso,
          maxLength: 300,
          maxLines: 2,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(counterText: ''),
        ),
        const DicaDeCampo('Portão azul, chamar no interfone 12, cachorro solto no quintal…'),
        const SizedBox(height: 18),
        Escolha(
          marcada: _principal,
          aoMudar: _salvando ? (_) {} : (valor) => setState(() => _principal = valor),
          titulo: 'Usar como endereço principal',
          descricao: 'É o que a van usa quando você pede o leva-e-traz.',
        ),
      ],
    );
  }
}

String _cepFormatado(String digitos) =>
    digitos.length == 8 ? '${digitos.substring(0, 5)}-${digitos.substring(5)}' : digitos;

/// `01310100` → `01310-100` enquanto se digita. O que vai ao servidor são só os dígitos.
class _MascaraDeCep extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue antigo, TextEditingValue novo) {
    var digitos = novo.text.replaceAll(RegExp(r'\D'), '');
    if (digitos.length > 8) digitos = digitos.substring(0, 8);
    final texto =
        digitos.length > 5 ? '${digitos.substring(0, 5)}-${digitos.substring(5)}' : digitos;
    return TextEditingValue(
      text: texto,
      selection: TextSelection.collapsed(offset: texto.length),
    );
  }
}
