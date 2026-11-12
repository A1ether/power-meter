import 'package:flutter/material.dart';

import '../format/formatters.dart';

/// 语义色（到期紧迫度 / 成功 / 警告）。
///
/// Material 3 的 ColorScheme 只有 error / primary 等角色，不足以表达
/// 「3 天内到期 / 7 天内到期 / 安全」这套三档语义，因此用 ThemeExtension 补齐，
/// 由组件按 `ExpiryLevel` 取色，不再各自硬编码。
@immutable
class AppTones extends ThemeExtension<AppTones> {
  const AppTones({
    required this.critical,
    required this.criticalContainer,
    required this.warning,
    required this.warningContainer,
    required this.success,
    required this.successContainer,
  });

  final Color critical;
  final Color criticalContainer;
  final Color warning;
  final Color warningContainer;
  final Color success;
  final Color successContainer;

  static const light = AppTones(
    critical: Color(0xFFC0392B),
    criticalContainer: Color(0xFFFFE3DF),
    warning: Color(0xFF9A6400),
    warningContainer: Color(0xFFFFF0D2),
    success: Color(0xFF0F6B4F),
    successContainer: Color(0xFFD7F7E9),
  );

  static const dark = AppTones(
    critical: Color(0xFFFF8A80),
    criticalContainer: Color(0xFF4A1512),
    warning: Color(0xFFFFC24B),
    warningContainer: Color(0xFF3D2A00),
    success: Color(0xFF5FE3B0),
    successContainer: Color(0xFF0B3A2B),
  );

  @override
  AppTones copyWith({
    Color? critical,
    Color? criticalContainer,
    Color? warning,
    Color? warningContainer,
    Color? success,
    Color? successContainer,
  }) =>
      AppTones(
        critical: critical ?? this.critical,
        criticalContainer: criticalContainer ?? this.criticalContainer,
        warning: warning ?? this.warning,
        warningContainer: warningContainer ?? this.warningContainer,
        success: success ?? this.success,
        successContainer: successContainer ?? this.successContainer,
      );

  @override
  AppTones lerp(ThemeExtension<AppTones>? other, double t) {
    if (other is! AppTones) return this;
    return AppTones(
      critical: Color.lerp(critical, other.critical, t)!,
      criticalContainer: Color.lerp(criticalContainer, other.criticalContainer, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningContainer: Color.lerp(warningContainer, other.warningContainer, t)!,
      success: Color.lerp(success, other.success, t)!,
      successContainer: Color.lerp(successContainer, other.successContainer, t)!,
    );
  }
}

extension AppTonesX on BuildContext {
  AppTones get tones => Theme.of(this).extension<AppTones>() ?? AppTones.dark;

  Color toneForExpiry(ExpiryLevel level) => switch (level) {
        ExpiryLevel.critical => tones.critical,
        ExpiryLevel.warning => tones.warning,
        ExpiryLevel.safe => tones.success,
        ExpiryLevel.none => Theme.of(this).colorScheme.onSurfaceVariant,
      };

  Color toneContainerForExpiry(ExpiryLevel level) => switch (level) {
        ExpiryLevel.critical => tones.criticalContainer,
        ExpiryLevel.warning => tones.warningContainer,
        ExpiryLevel.safe => tones.successContainer,
        ExpiryLevel.none => Theme.of(this).colorScheme.surfaceContainerHighest,
      };
}

const Color brandSeed = Color(0xFF5FE3B0);

ThemeData buildAppTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(
    seedColor: brandSeed,
    brightness: brightness,
  );
  final tones = brightness == Brightness.dark ? AppTones.dark : AppTones.light;
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    brightness: brightness,
    visualDensity: VisualDensity.standard,
    scaffoldBackgroundColor: brightness == Brightness.dark
        ? const Color(0xFF0B0D12)
        : scheme.surface,
  );

  TextStyle tabular(TextStyle style) => style.copyWith(
        fontFeatures: const [FontFeature.tabularFigures()],
      );

  final textTheme = base.textTheme.copyWith(
    displaySmall: tabular(base.textTheme.displaySmall!.copyWith(fontWeight: FontWeight.w600)),
    headlineSmall: tabular(base.textTheme.headlineSmall!.copyWith(fontWeight: FontWeight.w600)),
    titleLarge: base.textTheme.titleLarge!.copyWith(fontWeight: FontWeight.w600),
    titleMedium: base.textTheme.titleMedium!.copyWith(fontWeight: FontWeight.w600),
    bodyMedium: base.textTheme.bodyMedium!.copyWith(height: 1.45),
    bodySmall: base.textTheme.bodySmall!.copyWith(height: 1.4),
    labelSmall: base.textTheme.labelSmall!.copyWith(letterSpacing: 0.2),
  );

  return base.copyWith(
    textTheme: textTheme,
    extensions: [tones],
    cardTheme: CardThemeData(
      elevation: 0,
      margin: EdgeInsets.zero,
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    appBarTheme: AppBarTheme(
      centerTitle: false,
      elevation: 0,
      scrolledUnderElevation: 1,
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      titleTextStyle: textTheme.titleLarge,
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: scheme.surfaceContainerLow,
      indicatorColor: scheme.secondaryContainer,
      selectedIconTheme: IconThemeData(color: scheme.onSecondaryContainer),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: scheme.surfaceContainer,
      indicatorColor: scheme.secondaryContainer,
      elevation: 0,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: scheme.primary, width: 1.6),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    ),
    chipTheme: ChipThemeData(
      side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      labelStyle: textTheme.labelSmall,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant.withValues(alpha: 0.5),
      thickness: 1,
      space: 1,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
  );
}
