import 'package:flutter/material.dart';

import '../../auth/sessao.dart';
import '../../models/portal_models.dart';
import '../../ui/dados.dart';
import '../../ui/folha.dart';
import '../../ui/tema.dart';

/// Os dois campos que o tutor muda sozinho: nome social e nascimento (AC-01).
///
/// **Nome completo, CPF e contato não estão aqui, nem desabilitados.** Os dois primeiros
/// são conferidos com documento no balcão; o contato tem caminho próprio, com código.
/// Campo desabilitado é convite a tentar.
///
/// Devolve a ficha relida quando gravou, e `null` quando a pessoa desistiu.
Future<PortalMeDataResponse?> abrirEdicaoDoPerfil(
  BuildContext context,
  Sessao sessao,
  PortalProfile perfil,
) =>
    abrirFolha<PortalMeDataResponse>(
      context,
      (_) => _FormularioDoPerfil(sessao: sessao, perfil: perfil),
    );

class _FormularioDoPerfil extends StatefulWidget {
  const _FormularioDoPerfil({required this.sessao, required this.perfil});

  final Sessao sessao;
  final PortalProfile perfil;

  @override
  State<_FormularioDoPerfil> createState() => _FormularioDoPerfilState();
}

class _FormularioDoPerfilState extends State<_FormularioDoPerfil> {
  late final _social = TextEditingController(text: widget.perfil.socialName ?? '');
  late DateTime? _nascimento = dataDeCalendario(widget.perfil.birthDate);

  bool _salvando = false;
  String? _erro;

  @override
  void dispose() {
    _social.dispose();
    super.dispose();
  }

  Future<void> _escolherData() async {
    final hoje = widget.sessao.tempo.hoje;
    final escolhida = await showDatePicker(
      context: context,
      initialDate: _nascimento ?? DateTime(hoje.year - 30, hoje.month, hoje.day),
      firstDate: DateTime(hoje.year - 110),
      lastDate: hoje,
      // O calendário de mês em mês é o caminho mais longo até 1985; o campo digitado
      // chega lá em oito toques.
      initialEntryMode: DatePickerEntryMode.input,
    );
    if (escolhida != null) setState(() => _nascimento = escolhida);
  }

  Future<void> _salvar() async {
    setState(() {
      _salvando = true;
      _erro = null;
    });

    try {
      // Os dois vão sempre, e os nulos vão junto: `null` é o "apague" de quem limpou o
      // campo. Omitir manteria o valor antigo, e a folha fecharia dizendo que salvou.
      final social = _social.text.trim();
      final dados = await widget.sessao.api.atualizarPerfil(
        UpdateOwnTutor(
          socialName: social.isEmpty ? null : social,
          birthDate: _nascimento,
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
    final tema = Theme.of(context);
    final primeiroNome = widget.perfil.fullName.split(' ').first;

    return FolhaDeFormulario(
      icone: Icons.badge_rounded,
      titulo: 'Seus dados',
      descricao: 'Nome completo e documento são atualizados pelo estabelecimento.',
      rotuloDaAcao: 'Salvar',
      rotuloOcupado: 'Salvando…',
      ocupado: _salvando,
      aoConfirmar: _salvar,
      erro: _erro,
      filhos: [
        const RotuloDeCampo('Como prefere ser chamado'),
        TextField(
          controller: _social,
          maxLength: 120,
          textCapitalization: TextCapitalization.words,
          decoration: InputDecoration(counterText: '', hintText: primeiroNome),
        ),
        const DicaDeCampo('É este nome que aparece nas nossas mensagens e no atendimento.'),
        const SizedBox(height: 18),
        const RotuloDeCampo('Data de nascimento'),
        InkWell(
          onTap: _salvando ? null : _escolherData,
          borderRadius: BorderRadius.circular(Raio.controle),
          child: InputDecorator(
            decoration: InputDecoration(
              suffixIcon: _nascimento == null
                  ? const Icon(Icons.calendar_today_outlined, size: 20)
                  : IconButton(
                      tooltip: 'Limpar',
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: _salvando ? null : () => setState(() => _nascimento = null),
                    ),
            ),
            child: Text(
              _nascimento == null ? 'Não informada' : dataCurta(_nascimento!),
              style: TextStyle(
                color: _nascimento == null
                    ? tema.colorScheme.onSurfaceVariant
                    : tema.colorScheme.onSurface,
              ),
            ),
          ),
        ),
        const DicaDeCampo('Opcional. Serve só para lembrarmos da sua data.'),
      ],
    );
  }
}

/// `1990-04-12` → `DateTime` local, sem hora.
///
/// Sem fuso de propósito: nascimento é **dia de calendário**, e não um instante. Passar
/// por UTC é como um aniversário aparece um dia antes — o erro que ninguém reporta e
/// todo mundo nota.
DateTime? dataDeCalendario(String? iso) {
  if (iso == null || iso.isEmpty) return null;
  final partes = iso.split('-');
  if (partes.length != 3) return null;
  final ano = int.tryParse(partes[0]);
  final mes = int.tryParse(partes[1]);
  final dia = int.tryParse(partes[2]);
  if (ano == null || mes == null || dia == null) return null;
  return DateTime(ano, mes, dia);
}

String dataCurta(DateTime data) =>
    '${data.day.toString().padLeft(2, '0')}/${data.month.toString().padLeft(2, '0')}/${data.year}';
