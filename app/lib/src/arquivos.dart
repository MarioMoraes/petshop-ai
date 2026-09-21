import 'dart:io';
import 'dart:ui';

import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api/portal_client.dart';

/// As duas saídas do app para **fora dele**: abrir um endereço e entregar um arquivo.
///
/// O Financeiro é a primeira tela que produz documento em vez de tela — o recibo, que
/// vem como URL assinada, e o extrato, que vem em bytes —, e as duas coisas só
/// acontecem em plugin nativo: `url_launcher`, `path_provider` e `share_plus`.
///
/// **Por isso são variáveis, e não chamadas soltas dentro do widget.** Plugin não existe
/// no `flutter_test`: um `getTemporaryDirectory()` na árvore de teste lança
/// `MissingPluginException`, e o arnês que substitui o emulador neste projeto deixaria
/// de alcançar justamente o botão que se quer conferir. Com o ponto de troca aqui, o
/// teste dubla a entrega e afirma o que importa — que o app pediu o arquivo certo e que
/// o endereço aberto foi o que o servidor assinou —, e a tela continua com um caminho só.
///
/// É o mesmo desenho do `http_` injetado na `Sessao`, e da `setXPort` dos módulos do
/// backend: a dependência de fora do processo entra por um lugar nomeado.

/// Abre um endereço no navegador do aparelho. Devolve `false` quando não há quem o abra.
typedef AbrirEndereco = Future<bool> Function(Uri endereco);

/// Grava o arquivo e o entrega à folha de compartilhamento do sistema.
///
/// `origem` é o retângulo do botão que pediu, em coordenadas da tela: no iPad a folha é
/// um popover e precisa saber de onde sai. Nulo no telefone, onde ela sobe de baixo.
typedef EntregarArquivo = Future<void> Function(ArquivoDoPortal arquivo, {Rect? origem});

AbrirEndereco abrirEndereco = _abrirNoNavegador;
EntregarArquivo entregarArquivo = _entregarPelaFolhaDoSistema;

Future<bool> _abrirNoNavegador(Uri endereco) => launchUrl(
      endereco,
      // `externalApplication` e não a aba embutida: o que há do outro lado é um PDF, e
      // quem sabe baixá-lo, guardá-lo e imprimi-lo é o navegador do aparelho. Numa
      // WebView o arquivo abre e não tem para onde ir.
      mode: LaunchMode.externalApplication,
    );

Future<void> _entregarPelaFolhaDoSistema(ArquivoDoPortal arquivo, {Rect? origem}) async {
  // O diretório **temporário**, e não o de documentos: o extrato é um retrato de agora,
  // não um arquivo do app. Quem quiser guardá-lo escolhe onde na própria folha, e o
  // sistema recolhe o que ficou para trás.
  final pasta = await getTemporaryDirectory();
  final destino = File('${pasta.path}/${arquivo.nome}');
  await destino.writeAsBytes(arquivo.bytes, flush: true);

  await SharePlus.instance.share(
    ShareParams(
      files: [XFile(destino.path, mimeType: 'application/pdf')],
      sharePositionOrigin: origem,
    ),
  );
}
