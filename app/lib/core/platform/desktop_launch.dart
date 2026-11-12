import 'sidecar_handle.dart';

/// 桌面端启动结果（Web 端不产生实例）。
class DesktopLaunch {
  DesktopLaunch({required this.baseUrl, required this.token, required this.handle});

  final Uri baseUrl;
  final String token;
  final SidecarHandle handle;
}
