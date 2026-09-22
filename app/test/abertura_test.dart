import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:petshop_tutor/src/ui/abertura.dart';
import 'package:petshop_tutor/src/ui/tema.dart';

/// A cortina de abertura (`ui/abertura.dart`).
///
/// Três invariantes, e as três já foram defeito em alguma tela deste app: a de baixo
/// existe desde o começo, a de cima não engole o primeiro toque, e o que anima **acaba**.
void main() {
  Widget palco({required bool pronto, required VoidCallback aoTocar}) => MaterialApp(
        theme: temaDoPetshop(null, Brightness.light),
        home: Abertura(
          pronto: pronto,
          child: GestureDetector(
            onTap: aoTocar,
            behavior: HitTestBehavior.opaque,
            child: const Center(child: Text('a tela de verdade')),
          ),
        ),
      );

  testWidgets('a tela de verdade é montada por baixo desde o primeiro quadro',
      (tester) async {
    await tester.pumpWidget(palco(pronto: false, aoTocar: () {}));
    await tester.pump(const Duration(milliseconds: 900));

    // As duas ao mesmo tempo: é o que faz a saída da cortina não ter primeiro quadro a
    // construir — se a tela só nascesse depois, haveria um branco entre as duas.
    expect(find.text('Meu PetShop AI'), findsOneWidget);
    expect(find.text('a tela de verdade'), findsOneWidget);
  });

  testWidgets('a cortina segura o toque enquanto está na frente', (tester) async {
    var toques = 0;
    void tocou() => toques++;

    await tester.pumpWidget(palco(pronto: false, aoTocar: tocou));
    await tester.pump(const Duration(milliseconds: 600));

    await tester.tapAt(tester.getCenter(find.byType(MaterialApp)));
    await tester.pump();
    expect(toques, 0, reason: 'a cortina está na frente');

    await tester.pumpWidget(palco(pronto: true, aoTocar: tocou));
    await tester.pumpAndSettle();

    await tester.tapAt(tester.getCenter(find.byType(MaterialApp)));
    await tester.pump();
    expect(toques, 1, reason: 'a cortina saiu e o toque chega à tela');
  });

  testWidgets('a abertura termina sozinha e não deixa nada animando', (tester) async {
    await tester.pumpWidget(palco(pronto: true, aoTocar: () {}));

    // `pumpAndSettle` é a prova: ele só volta quando ninguém mais pede quadro. Um
    // controlador em `repeat()` esquecido aqui pendura a suíte inteira do app, que
    // passa por esta cortina em todo teste de tela.
    await tester.pumpAndSettle();

    expect(find.text('Meu PetShop AI'), findsNothing);
    expect(find.text('a tela de verdade'), findsOneWidget);
  });
}
