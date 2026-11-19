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

/* ------------------------------------------------------------------ *
 * 每日签到
 * ------------------------------------------------------------------ */

/// 正在签到的账号键 `provider|accountId`（卡片与弹窗共享，保证两边按钮同步禁用）。
final checkinBusyProvider = StateProvider<Set<String>>((ref) => <String>{});

/// 「一键签到全部」进行中。
final checkinAllBusyProvider = StateProvider<bool>((ref) => false);

final checkinProvider = AsyncNotifierProvider<CheckinNotifier, CheckinStatus>(
  CheckinNotifier.new,
);

class CheckinNotifier extends AsyncNotifier<CheckinStatus> {
  @override
  Future<CheckinStatus> build() async {
    ref.watch(apiProvider);
    return ref.read(apiProvider).checkinStatus();
  }

  /// 静默重读；失败时保留上一次成功数据，避免弹窗因一次网络抖动清空。
  Future<void> reload() async {
    final previous = state;
    try {
      state = AsyncValue.data(await ref.read(apiProvider).checkinStatus());
    } catch (error, stackTrace) {
      state = AsyncValue<CheckinStatus>.error(error, stackTrace).copyWithPrevious(previous);
    }
  }

  void _setBusy(String key, bool busy) {
    ref.read(checkinBusyProvider.notifier).update(
          (set) => busy ? <String>{...set, key} : (<String>{...set}..remove(key)),
        );
  }

  void _refreshDashboard() {
    unawaited(ref.read(dashboardProvider.notifier).refresh(force: true, silent: true));
  }

  /// 单账号签到：成功后重读状态；只有 claimed 才需要刷新看板余额。
  Future<CheckinRecord> runOne({required String provider, required String accountId}) async {
    final key = checkinKeyOf(provider, accountId);
    if (ref.read(checkinBusyProvider).contains(key)) throw ApiException('该账号正在签到');
    _setBusy(key, true);
    try {
      final record = await ref.read(apiProvider).runCheckin(
            provider: provider,
            accountId: accountId,
          );
      await reload();
      if (record.outcome == 'claimed') _refreshDashboard();
      return record;
    } finally {
      _setBusy(key, false);
    }
  }

  /// 一键签到全部；服务端并发 2，单账号失败不影响其它账号。
  Future<List<CheckinRecord>> runAll() async {
    final busy = ref.read(checkinAllBusyProvider.notifier);
    if (busy.state) return const [];
    busy.state = true;
    try {
      final results = await ref.read(apiProvider).runAllCheckins();
      await reload();
      if (results.any((record) => record.outcome == 'claimed')) _refreshDashboard();
      return results;
    } finally {
      busy.state = false;
    }
  }

  Future<CheckinSettings> updateSettings({bool? auto, String? at}) async {
    final settings = await ref.read(apiProvider).updateCheckinSettings(auto: auto, at: at);
    state = AsyncValue.data(
      (state.valueOrNull ?? const CheckinStatus()).copyWith(settings: settings),
    );
    return settings;
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
