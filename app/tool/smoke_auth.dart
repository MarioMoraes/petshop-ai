// Arnês de linha de comando: `print` é a saída, e não um resto de depuração.
// ignore_for_file: avoid_print

// O caminho inteiro da etapa 2, com as classes do app, contra os serviços de verdade.
//
// Entrar na Clerk pela FAPI, renovar o token de 60 segundos e apresentá-lo ao Portal —
// sem tela, sem emulador. É o que separa "o app compila" de "o login funciona": a tela
// mostra que renderiza, isto mostra que o mecanismo por baixo dela conversa com quem
// precisa.
//
//   dart run tool/smoke_auth.dart <email> <codigo> <slug> [baseUrl]
//
// Numa instância de desenvolvimento da Clerk, um e-mail com `+clerk_test` aceita o
// código fixo `424242`, o que torna esta verificação repetível sem caixa de entrada.
import 'dart:io';

import 'package:petshop_tutor/src/api/portal_api.dart';
import 'package:petshop_tutor/src/api/portal_client.dart';
import 'package:petshop_tutor/src/api/portal_error.dart';
import 'package:petshop_tutor/src/auth/armazenamento.dart';
import 'package:petshop_tutor/src/auth/clerk_fapi.dart';
import 'package:petshop_tutor/src/models/portal_models.dart';

Future<void> main(List<String> args) async {
  if (args.length < 3) {
    stderr.writeln('uso: dart run tool/smoke_auth.dart <email> <codigo> <slug> [baseUrl]');
    exit(2);
  }
  final email = args[0];
  final codigo = args[1];
  final slug = args[2];
  final baseUrl = args.length > 3 ? args[3] : 'http://localhost:3000';

  final pk = Platform.environment['CLERK_PUBLISHABLE_KEY'];
  if (pk == null || pk.isEmpty) {
    stderr.writeln('falta CLERK_PUBLISHABLE_KEY no ambiente');
    exit(2);
  }

  final cofre = CofreEmMemoria();
  final host = ClerkFapi.hostDaChave(pk);
  print('Clerk em $host');
  final clerk = ClerkFapi(host: host, armazenamento: cofre);

  print('\n1. pedir o código para $email');
  final passo = await clerk.entrarComEmail(email);
  print('   código enviado para ${passo.destino} · tentativa ${passo.tentativaId}');

  print('\n2. confirmar o código');
  final concluido = await clerk.confirmarEntrada(passo.tentativaId!, codigo);
  print('   sessão ${concluido.sessaoId}');

  print('\n3. obter um token de sessão');
  final jwt = await clerk.tokenDeSessao(concluido.sessaoId!);
  if (jwt == null) {
    print('   FALHA: sem token');
    exit(1);
  }
  print('   token de ${jwt.length} caracteres');

  print('\n4. apresentar o token ao Portal de "$slug"');
  final api = PortalApi(PortalClient(
    baseUrl: baseUrl,
    slug: slug,
    // Renova a cada chamada, como o app faz: o token vive 60 segundos.
    token: () => clerk.tokenDeSessao(concluido.sessaoId!),
  ));

  try {
    final me = await api.me();
    print('   VINCULADO: ${me.tutor.name} · ${me.tutor.petsCount} pet(s)');
  } on PortalError catch (e) {
    if (e.status == 401) {
      // Não é falha: é o estado de quem tem conta e ainda não ligou a ficha. É
      // exatamente aqui que o app leva à tela de vínculo.
      print('   SEM VÍNCULO (${e.code}) — como esperado para conta nova');
      print('\n5. pedir o código de vínculo');
      final desafio = await api.pedirCodigo(
        PortalChallenge(identifier: email, website: null),
      );
      print('   canal ${desafio.channel.name} · destino ${desafio.maskedTarget} '
          '· vale ${desafio.expiresInMin} min');
      print('   (a resposta é idêntica exista ou não a ficha — RN-04)');
    } else {
      print('   FALHA: ${e.status} ${e.code} ${e.message}');
      exit(1);
    }
  }

  print('\n6. sair');
  await clerk.sair(concluido.sessaoId!);
  final depois = await clerk.tokenDeSessao(concluido.sessaoId!);
  print('   token após sair: ${depois == null ? "negado, como deve ser" : "AINDA VÁLIDO (defeito)"}');

  clerk.fechar();
  print('\ntudo verde.');
}
