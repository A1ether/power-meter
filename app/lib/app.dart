import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/platform/runtime.dart';
import 'core/theme/app_theme.dart';
import 'features/accounts/connection_page.dart';
import 'features/shell/home_shell.dart';
import 'state/providers.dart';

class PowerMeterApp extends ConsumerWidget {
  const PowerMeterApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeProvider);
    return MaterialApp(
      title: 'Power Meter',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(Brightness.light),
      darkTheme: buildAppTheme(Brightness.dark),
      themeMode: themeMode,
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const _RootGate(),
    );
  }
}

/// 启动后的第一道门：后端不可用 → 错误 / 连接页；就绪 → 看板。
class _RootGate extends ConsumerStatefulWidget {
  const _RootGate();

  @override
  ConsumerState<_RootGate> createState() => _RootGateState();
}

class _RootGateState extends ConsumerState<_RootGate> {
  AppLifecycleListener? _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onResume: () {
        if (mounted) ref.read(dashboardProvider.notifier).refresh(force: false, silent: true);
      },
      onExitRequested: () async {
        await ref.read(runtimeProvider).dispose();
        return AppExitResponse.exit;
      },
    );
  }

  @override
  void dispose() {
    _lifecycle?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final runtime = ref.watch(runtimeProvider);
    if (runtime.launchError != null) {
      return BackendErrorPage(message: runtime.launchError!);
    }
    if (!runtime.ready) {
      return ConnectionPage(
        initialUrl: runtime.flavor == AppFlavor.mobile ? '' : 'http://127.0.0.1:48213',
      );
    }
    return const HomeShell();
  }
}
