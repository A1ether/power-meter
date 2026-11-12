import 'dart:io';

import 'desktop_launch.dart';
import 'sidecar.dart';

/// 桌面形态（macOS / Windows / Linux）启动后端；其它平台返回 null。
Future<DesktopLaunch?> startDesktopBackend() async {
  final supported = Platform.isMacOS || Platform.isWindows || Platform.isLinux;
  if (!supported) return null;

  final launcher = SidecarLauncher();
  final baseUrl = await launcher.start();
  return DesktopLaunch(baseUrl: baseUrl, token: launcher.token, handle: launcher);
}
