import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/platform/runtime.dart';
import '../../state/providers.dart';

/// 桌面 sidecar 启动失败时的兜底页。
class BackendErrorPage extends ConsumerStatefulWidget {
  const BackendErrorPage({super.key, required this.message});

  final String message;

  @override
  ConsumerState<BackendErrorPage> createState() => _BackendErrorPageState();
}

class _BackendErrorPageState extends ConsumerState<BackendErrorPage> {
  bool _retrying = false;

  Future<void> _retry() async {
    setState(() => _retrying = true);
    try {
      ref.read(runtimeProvider.notifier).state = await AppRuntime.bootstrap(
        ref.read(settingsStoreProvider),
      );
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.dns_outlined, size: 44, color: scheme.error),
                const SizedBox(height: 16),
                Text('后端服务未能启动', style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 10),
                Text(
                  widget.message,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                ),
                const SizedBox(height: 24),
                FilledButton.icon(
                  onPressed: _retrying ? null : _retry,
                  icon: _retrying
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh),
                  label: Text(_retrying ? '正在重试…' : '重试'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 移动端首次启动的「连接服务」页，也用于之后修改服务地址。
class ConnectionPage extends ConsumerStatefulWidget {
  const ConnectionPage({super.key, this.initialUrl = ''});

  final String initialUrl;

  @override
  ConsumerState<ConnectionPage> createState() => _ConnectionPageState();
}

class _ConnectionPageState extends ConsumerState<ConnectionPage> {
  late final TextEditingController _url = TextEditingController(text: widget.initialUrl);
  late final TextEditingController _token = TextEditingController(
    text: ref.read(settingsStoreProvider).serverToken,
  );
  bool _testing = false;
  String? _result;
  bool _ok = false;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Uri? _parseUrl() {
    final raw = _url.text.trim();
    if (raw.isEmpty) return null;
    var normalized = raw;
    if (!normalized.contains('://')) normalized = 'http://$normalized';
    final uri = Uri.tryParse(normalized);
    if (uri == null || uri.host.isEmpty) return null;
    return uri.path.endsWith('/') ? uri : uri.replace(path: '${uri.path}/');
  }

  Future<void> _test() async {
    final uri = _parseUrl();
    if (uri == null) {
      setState(() {
        _ok = false;
        _result = '服务地址格式不正确，例如 http://192.168.1.10:48213';
      });
      return;
    }
    setState(() {
      _testing = true;
      _result = null;
    });
    try {
      final client = ApiClient(baseUrl: uri, token: _token.text.trim());
      final healthy = await client.health();
      client.close();
      setState(() {
        _ok = healthy;
        _result = healthy ? '连接成功，可以保存了。' : '健康检查失败：服务未响应或令牌不匹配。';
      });
    } catch (error) {
      setState(() {
        _ok = false;
        _result = '连接失败：$error';
      });
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _save() async {
    final uri = _parseUrl();
    if (uri == null) return;
    final token = _token.text.trim();
    await ref.read(settingsStoreProvider).saveServer(baseUrl: uri.toString(), token: token);
    final current = ref.read(runtimeProvider);
    ref.read(runtimeProvider.notifier).state = current.reconnect(baseUrl: uri, token: token);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('连接 Power Meter 服务')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(Icons.bolt_rounded, size: 40, color: scheme.primary),
                    const SizedBox(height: 12),
                    Text('连接到本机的看板服务', style: theme.textTheme.titleLarge),
                    const SizedBox(height: 8),
                    Text(
                      '在运行后端服务的电脑上执行：\n'
                      'npm run dev（默认 48213 端口）\n'
                      '需要跨设备访问时加 HOST=0.0.0.0，并设置访问令牌。',
                      style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      controller: _url,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: '服务地址',
                        hintText: 'http://192.168.1.10:48213',
                        prefixIcon: Icon(Icons.link),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _token,
                      obscureText: true,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        labelText: '访问令牌（可选）',
                        hintText: '与服务端 POWER_METER_TOKEN 一致',
                        prefixIcon: Icon(Icons.key_outlined),
                      ),
                    ),
                    if (_result != null) ...[
                      const SizedBox(height: 14),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            _ok ? Icons.check_circle : Icons.error_outline,
                            size: 18,
                            color: _ok ? scheme.primary : scheme.error,
                          ),
                          const SizedBox(width: 8),
                          Expanded(child: Text(_result!, style: theme.textTheme.bodySmall)),
                        ],
                      ),
                    ],
                    const SizedBox(height: 20),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _testing ? null : _test,
                            icon: _testing
                                ? const SizedBox.square(
                                    dimension: 14,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(Icons.wifi_tethering),
                            label: Text(_testing ? '测试中…' : '测试连接'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: _save,
                            icon: const Icon(Icons.login),
                            label: const Text('保存并进入'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text(
                      '移动端为只读看板：账号增删、密钥读取与扫码登录仅在本机客户端可用。',
                      style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
