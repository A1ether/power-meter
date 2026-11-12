import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'sidecar_handle.dart';

/// macOS / Windows / Linux 桌面端的后端 sidecar 启动器。
///
/// 与旧 Swift 壳（`desktop/macos/PowerMeterApp.swift`）保持同样的契约：
///   1. 在 Application Support/PowerMeter 下准备配置目录与首次启动种子；
///   2. `--port 0` 让内核分配随机端口，`--token` 给本次进程一个随机访问令牌；
///   3. 从 stdout 的稳定就绪行解析真实端口；
///   4. 退出时 `SIGTERM`，超时未退出则强制结束。
///
/// 开发态（`flutter run -d macos`）通常没有随包 sidecar，此时回退到本机
/// 固定端口 `127.0.0.1:48213` 的现有服务；仍不可用则把错误交给 UI 展示。
class SidecarLauncher implements SidecarHandle {
  Process? _process;
  StreamSubscription<String>? _stdoutSub;
  StreamSubscription<String>? _stderrSub;
  final List<String> _recentOutput = [];

  String token = '';
  Uri? baseUrl;
  String? error;

  static const int fallbackPort = 48213;

  Future<Uri> start() async {
    final override = const String.fromEnvironment('POWER_METER_BASE_URL');
    if (override.isNotEmpty) {
      token = const String.fromEnvironment('POWER_METER_TOKEN');
      final uri = Uri.parse(override);
      baseUrl = uri;
      return uri;
    }

    final binary = _findSidecar();
    if (binary == null) {
      final fallback = Uri.parse('http://127.0.0.1:$fallbackPort/');
      if (await _probe(fallback)) {
        baseUrl = fallback;
        token = '';
        return fallback;
      }
      throw StateError(
        '找不到随包的 power-meter-sidecar，且本机 $fallbackPort 端口没有正在运行的服务。\n'
        '桌面版请用 tools/build-flutter-macos-app.sh 打包；开发时先运行 npm run dev，'
        '或用 --dart-define=POWER_METER_BASE_URL=http://127.0.0.1:48213 指定服务地址。',
      );
    }

    final configDir = await _prepareConfigDir();
    token = _randomToken();
    final process = await Process.start(binary, [
      '--port', '0',
      '--no-static',
      '--token', token,
      '--config-dir', configDir.path,
    ]);
    _process = process;
    final ready = Completer<Uri>();

    void consume(String line) {
      _recentOutput.add(line);
      if (_recentOutput.length > 80) _recentOutput.removeAt(0);
      final match = RegExp(r'listening at (http://[^\s]+)').firstMatch(line);
      if (match != null && !ready.isCompleted) {
        ready.complete(Uri.parse('${match.group(1)}/'));
      }
    }

    _stdoutSub = process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen(consume);
    // stderr 只保留最近若干行用于报错展示，不写入文件、不打印到业务日志。
    _stderrSub = process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen(consume);

    unawaited(process.exitCode.then((code) {
      if (!ready.isCompleted) {
        ready.completeError(StateError('sidecar 退出（code=$code）：${_recentOutput.join('\n')}'));
      }
    }));

    try {
      final uri = await ready.future.timeout(const Duration(seconds: 25));
      baseUrl = uri;
      return uri;
    } on TimeoutException {
      await stop();
      throw StateError('sidecar 启动超时。最近输出：\n${_recentOutput.join('\n')}');
    } catch (error) {
      await stop();
      rethrow;
    }
  }

  @override
  Future<void> stop() async {
    await _stdoutSub?.cancel();
    await _stderrSub?.cancel();
    final process = _process;
    _process = null;
    if (process == null) return;
    process.kill(ProcessSignal.sigterm);
    try {
      await process.exitCode.timeout(const Duration(seconds: 3));
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
    }
  }

  String? _findSidecar() {
    final executable = File(Platform.resolvedExecutable).parent;
    final candidates = <String>[
      // macOS .app：Contents/MacOS/<exe> → Contents/Resources/power-meter-sidecar
      p.join(executable.parent.path, 'Resources', 'power-meter-sidecar'),
      p.join(executable.path, 'power-meter-sidecar'),
      // 仓库内直接运行 flutter run 时的构建产物
      p.join(Directory.current.path, 'dist', 'power-meter-sidecar'),
      p.join(Directory.current.path, '..', 'dist', 'power-meter-sidecar'),
    ];
    for (final path in candidates) {
      if (File(path).existsSync()) return path;
    }
    return null;
  }

  Future<Directory> _prepareConfigDir() async {
    final home = Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? Directory.current.path;
    final base = Platform.isMacOS
        ? p.join(home, 'Library', 'Application Support')
        : Platform.isWindows
            ? (Platform.environment['APPDATA'] ?? p.join(home, 'AppData', 'Roaming'))
            : (Platform.environment['XDG_CONFIG_HOME'] ?? p.join(home, '.config'));
    final dir = Directory(p.join(base, 'PowerMeter'));
    if (!dir.existsSync()) dir.createSync(recursive: true);

    final accounts = File(p.join(dir.path, 'accounts.json'));
    if (!accounts.existsSync()) {
      final seed = _findSeed();
      if (seed != null) {
        try {
          File(seed).copySync(accounts.path);
        } catch (error) {
          debugPrint('写入首次启动账号模板失败：$error');
        }
      }
    }
    return dir;
  }

  String? _findSeed() {
    final executable = File(Platform.resolvedExecutable).parent;
    final candidates = <String>[
      p.join(executable.parent.path, 'Resources', 'seed', 'accounts.template.json'),
      p.join(Directory.current.path, 'desktop', 'macos', 'seed', 'accounts.template.json'),
      p.join(Directory.current.path, '..', 'desktop', 'macos', 'seed', 'accounts.template.json'),
    ];
    for (final path in candidates) {
      if (File(path).existsSync()) return path;
    }
    return null;
  }

  String _randomToken() {
    final random = Random.secure();
    final bytes = List<int>.generate(24, (_) => random.nextInt(256));
    return base64UrlEncode(bytes).replaceAll('=', '');
  }

  Future<bool> _probe(Uri baseUrl) async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
      final request = await client.getUrl(baseUrl.resolve('api/health'));
      final response = await request.close().timeout(const Duration(seconds: 3));
      await response.drain<void>();
      client.close(force: true);
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
