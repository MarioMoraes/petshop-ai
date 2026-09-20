import 'package:flutter/material.dart';

/// O tema do app, semeado pela cor do estabelecimento.
///
/// `brandColor` vem de `GET /portal/v1/tenant`, que é anônimo — a marca já está
/// disponível na primeira tela, antes de haver qualquer sessão. Um app do tutor que
/// parecesse igual em todo petshop perderia justamente o que o produto vende: é o
/// estabelecimento dele que está ali, não a plataforma.
ThemeData temaDoPetshop(String? brandColor, Brightness brilho) {
  final semente = _corDe(brandColor) ?? const Color(0xFFE34A32);
  final esquema = ColorScheme.fromSeed(seedColor: semente, brightness: brilho);

  return ThemeData(
    colorScheme: esquema,
    useMaterial3: true,
    scaffoldBackgroundColor: esquema.surface,
    appBarTheme: AppBarTheme(
      backgroundColor: esquema.surface,
      foregroundColor: esquema.onSurface,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: esquema.surfaceContainerHighest.withValues(alpha: 0.4),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: esquema.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      margin: EdgeInsets.zero,
    ),
  );
}

/// `#E34A32` ou `E34A32`. Cor inválida cai no padrão, porque tema quebrado não é motivo
/// para a tela não abrir.
Color? _corDe(String? hex) {
  if (hex == null) return null;
  final limpo = hex.replaceAll('#', '').trim();
  if (limpo.length != 6) return null;
  final valor = int.tryParse(limpo, radix: 16);
  return valor == null ? null : Color(0xFF000000 | valor);
}
