import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import 'settings_store.dart';
import 'desktop_bootstrap_stub.dart' if (dart.library.io) 'desktop_bootstrap_io.dart';
import 'sidecar_handle.dart';

enum AppFlavor { web, desktop, mobile }

/// 运行形态与后端连接信息。
///
/// 三端的差异集中在这里，UI 只读 `canManageAccounts` / `supportsLogin`，
/// 不自行判断平台（与仓库「前端不认平台名」的取向一致）。
class AppRuntime {
  AppRuntime({
    required this.flavor,
    required this.baseUrl,
    required this.token,
    this.launchError,
    this.sidecar,
  });

  final AppFlavor flavor;
  final Uri? baseUrl;
  final String token;
  final String? launchError;
  final SidecarHandle? sidecar;

  bool get ready => baseUrl != null;
  bool get isWeb => flavor == AppFlavor.web;
  bool get isDesktop => flavor == AppFlavor.desktop;
  bool get isMobile => flavor == AppFlavor.mobile;

  /// 账号增删 / 密钥读取：Web 与桌面可用；移动端默认只读（见设计方案 §3.10）。
  bool get canManageAccounts => !isMobile;

  /// 扫码 / 链接登录：仅本机形态可用（Trae 回调固定 127.0.0.1）。
  bool get supportsLogin => !isMobile;

  ApiClient? _client;

  ApiClient get api {
    final uri = baseUrl;
    if (uri == null) throw StateError('后端地址尚未就绪');
    return _client ??= ApiClient(baseUrl: uri, token: token);
  }

  /// 移动端在「连接服务」页保存新地址后，用同一运行形态重建客户端。
  AppRuntime reconnect({required Uri baseUrl, required String token}) {
    _client?.close();
    return AppRuntime(
      flavor: flavor,
      baseUrl: baseUrl,
      token: token,
      sidecar: sidecar,
    );
  }

  static Future<AppRuntime> bootstrap(SettingsStore settings) async {
    if (kIsWeb) {
      final origin = Uri.base.origin;
      return AppRuntime(
        flavor: AppFlavor.web,
        baseUrl: Uri.parse('$origin/'),
        token: '',
      );
    }

    // 桌面：优先随包 sidecar；找不到时回退本机固定端口 / dart-define。
    if (defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.windows ||
        defaultTargetPlatform == TargetPlatform.linux) {
      try {
        final launch = await startDesktopBackend();
        if (launch != null) {
          return AppRuntime(
            flavor: AppFlavor.desktop,
            baseUrl: launch.baseUrl,
            token: launch.token,
            sidecar: launch.handle,
          );
        }
      } catch (error) {
        return AppRuntime(
          flavor: AppFlavor.desktop,
          baseUrl: null,
          token: '',
          launchError: '$error',
        );
      }
    }

    // 移动端：连接信息来自本地设置；未配置时由连接页处理。
    return AppRuntime(
      flavor: AppFlavor.mobile,
      baseUrl: settings.serverBaseUrl,
      token: settings.serverToken,
    );
  }

  Future<void> dispose() async {
    _client?.close();
    await sidecar?.stop();
  }
}
