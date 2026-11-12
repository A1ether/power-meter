/// 桌面端启动器的公共句柄类型（不含 dart:io，Web 也能编译）。
abstract class SidecarHandle {
  Future<void> stop();
}
