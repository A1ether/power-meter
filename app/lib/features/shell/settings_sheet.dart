import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/platform/runtime.dart';
import '../../state/providers.dart';

Future<void> showSettingsSheet(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const SettingsSheet(),
  );
}

class SettingsSheet extends ConsumerStatefulWidget {
  const SettingsSheet({super.key});

  @override
  ConsumerState<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends ConsumerState<SettingsSheet> {
  late final TextEditingController _url;
  late final TextEditingController _token;
  String? _saveMessage;

  @override
  void initState() {
    super.initState();
    final runtime = ref.read(runtimeProvider);
    final store = ref.read(settingsStoreProvider);
    _url = TextEditingController(text: runtime.baseUrl?.toString() ?? '');
    _token = TextEditingController(text: store.serverToken);
  }

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _saveServer() async {
    var raw = _url.text.trim();
    if (raw.isEmpty) return;
    if (!raw.contains('://')) raw = 'http://$raw';
    var uri = Uri.tryParse(raw);
    if (uri == null || uri.host.isEmpty) {
      setState(() => _saveMessage = '服务地址格式不正确');
      return;
    }
    if (!uri.path.endsWith('/')) uri = uri.replace(path: '${uri.path}/');
    final token = _token.text.trim();
    await ref.read(settingsStoreProvider).saveServer(baseUrl: uri.toString(), token: token);
    final current = ref.read(runtimeProvider);
    ref.read(runtimeProvider.notifier).state = current.reconnect(baseUrl: uri, token: token);
    setState(() => _saveMessage = '已保存，正在使用新的服务地址');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final runtime = ref.watch(runtimeProvider);
    final mode = ref.watch(themeModeProvider);
    final autoRefresh = ref.watch(autoRefreshProvider);

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('设置', style: theme.textTheme.titleLarge),
              const SizedBox(height: 20),
              Text('外观', style: theme.textTheme.labelLarge),
              const SizedBox(height: 8),
              SegmentedButton<ThemeMode>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: ThemeMode.system, icon: Icon(Icons.brightness_auto), label: Text('跟随系统')),
                  ButtonSegment(value: ThemeMode.light, icon: Icon(Icons.light_mode_outlined), label: Text('浅色')),
                  ButtonSegment(value: ThemeMode.dark, icon: Icon(Icons.dark_mode_outlined), label: Text('深色')),
                ],
                selected: {mode},
                onSelectionChanged: (selection) =>
                    ref.read(themeModeProvider.notifier).set(selection.first),
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('自动刷新', style: theme.textTheme.labelLarge),
                        Text(
                          '每 5 分钟读取一次缓存；手动刷新会强制重新取数',
                          style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  Switch(
                    value: autoRefresh,
                    onChanged: (value) => ref.read(autoRefreshProvider.notifier).state = value,
                  ),
                ],
              ),
              const Divider(height: 32),
              Text('运行信息', style: theme.textTheme.labelLarge),
              const SizedBox(height: 8),
              _InfoRow(label: '运行形态', value: switch (runtime.flavor) {
                AppFlavor.web => 'Web（同源托管）',
                AppFlavor.desktop => '桌面应用（内置 sidecar）',
                AppFlavor.mobile => '移动端（只读）',
              }),
              _InfoRow(label: '服务地址', value: runtime.baseUrl?.toString() ?? '未连接'),
              _InfoRow(label: '访问令牌', value: runtime.token.isEmpty ? '未设置' : '已设置'),
              _InfoRow(label: '账号管理', value: runtime.canManageAccounts ? '可用' : '移动端只读'),
              if (runtime.isMobile) ...[
                const Divider(height: 32),
                Text('服务连接', style: theme.textTheme.labelLarge),
                const SizedBox(height: 8),
                TextField(
                  controller: _url,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: '服务地址',
                    hintText: 'http://192.168.1.10:48213',
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _token,
                  obscureText: true,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: '访问令牌（可选）',
                    hintText: '与服务端 POWER_METER_TOKEN 一致',
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _saveServer,
                  icon: const Icon(Icons.link),
                  label: const Text('保存连接'),
                ),
                if (_saveMessage != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_saveMessage!, style: theme.textTheme.labelSmall),
                  ),
              ],
              const Divider(height: 32),
              Text(
                'Power Meter · Flutter 客户端\n'
                '运行时零服务端依赖；凭证仅保存在本机 .env / accounts.json。',
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ),
          Expanded(child: SelectableText(value, style: theme.textTheme.bodySmall)),
        ],
      ),
    );
  }
}
