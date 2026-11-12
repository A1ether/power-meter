import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/api_client.dart';
import '../core/models/dashboard_logic.dart';
import '../core/models/models.dart';
import '../core/platform/runtime.dart';
import '../core/platform/settings_store.dart';

/// 运行形态与后端连接（由 main.dart 在启动时 override）。
final runtimeProvider = StateProvider<AppRuntime>((ref) => throw UnimplementedError());

/// 本地设置（主题、移动端连接信息）。
final settingsStoreProvider = Provider<SettingsStore>((ref) => throw UnimplementedError());

final apiProvider = Provider<ApiClient>((ref) => ref.watch(runtimeProvider).api);

final registryProvider = FutureProvider<List<ProviderMeta>>((ref) async {
  return ref.watch(apiProvider).providers();
});

final registryMapProvider = Provider<Map<String, ProviderMeta>>((ref) {
  final list = ref.watch(registryProvider).valueOrNull ?? const <ProviderMeta>[];
  return {for (final meta in list) meta.id: meta};
});

/// 5 分钟自动刷新（对应 `app.js:4` 的 REFRESH_INTERVAL_MS）。
final autoRefreshProvider = StateProvider<bool>((ref) => true);

final dashboardProvider = AsyncNotifierProvider<DashboardNotifier, DashboardPayload>(
  DashboardNotifier.new,
);

class DashboardNotifier extends AsyncNotifier<DashboardPayload> {
  Timer? _timer;
  static const refreshInterval = Duration(minutes: 5);

  @override
  Future<DashboardPayload> build() async {
    ref.onDispose(() => _timer?.cancel());
    // 服务地址 / 令牌变化（移动端重新连接）时重建快照。
    ref.watch(apiProvider);
    _timer = Timer.periodic(refreshInterval, (_) {
      if (ref.read(autoRefreshProvider)) unawaited(refresh(force: false, silent: true));
    });
    return ref.read(apiProvider).summary();
  }

  /// 手动刷新 = 重新读配置并强制取数（`?force=1`）；自动刷新读缓存。
  Future<void> refresh({bool force = true, bool silent = false}) async {
    final previous = state;
    if (!silent) {
      state = const AsyncValue<DashboardPayload>.loading().copyWithPrevious(previous);
    }
    try {
      final payload = await ref.read(apiProvider).summary(force: force);
      state = AsyncValue.data(payload);
    } catch (error, stackTrace) {
      state = AsyncValue<DashboardPayload>.error(error, stackTrace).copyWithPrevious(previous);
    }
  }
}

final searchQueryProvider = StateProvider<String>((ref) => '');
final sortModeProvider = StateProvider<SortMode>((ref) => SortMode.expiry);

/// 排序 / 筛选后的卡片列表（对应 `app.js` 的 sortedProviders）。
final visibleProvidersProvider = Provider<List<ProviderSnapshot>>((ref) {
  final payload = ref.watch(dashboardProvider).valueOrNull;
  if (payload == null) return const [];
  return sortedProviders(
    payload.providers,
    sort: ref.watch(sortModeProvider),
    query: ref.watch(searchQueryProvider),
    thresholds: payload.expiryThresholds,
  );
});

/// 「按平台」分组：同一平台的多个账号合并为一行。
final platformGroupsProvider = Provider<List<PlatformGroup>>((ref) {
  final payload = ref.watch(dashboardProvider).valueOrNull;
  if (payload == null) return const [];
  return platformGroups(payload.providers, ref.watch(registryMapProvider));
});

final themeModeProvider = StateNotifierProvider<ThemeModeNotifier, ThemeMode>((ref) {
  return ThemeModeNotifier(ref.watch(settingsStoreProvider));
});

class ThemeModeNotifier extends StateNotifier<ThemeMode> {
  ThemeModeNotifier(this._settings) : super(_read(_settings.themeMode));

  final SettingsStore _settings;

  static ThemeMode _read(String value) => switch (value) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };

  Future<void> set(ThemeMode mode) async {
    state = mode;
    await _settings.saveThemeMode(mode.name);
  }
}
