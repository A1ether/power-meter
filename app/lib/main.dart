import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/platform/runtime.dart';
import 'core/platform/settings_store.dart';
import 'state/providers.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final settings = await SettingsStore.load();
  final runtime = await AppRuntime.bootstrap(settings);

  runApp(
    ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(settings),
        runtimeProvider.overrideWith((ref) => runtime),
      ],
      child: const PowerMeterApp(),
    ),
  );
}
