import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/models.dart';
import '../../core/platform/runtime.dart';
import '../../state/providers.dart';
import 'manage_panel.dart';

/// 「平台与账号」弹窗：列出全部内置平台（含一个账号都没有的平台），
/// 在这里登录、填写凭证或删除账号。
Future<void> showPlatformsDialog(BuildContext context, WidgetRef ref) {
  return showDialog<void>(
    context: context,
    builder: (_) => const PlatformsDialog(),
  );
}

class PlatformsDialog extends ConsumerStatefulWidget {
  const PlatformsDialog({super.key});

  @override
  ConsumerState<PlatformsDialog> createState() => _PlatformsDialogState();
}

class _PlatformsDialogState extends ConsumerState<PlatformsDialog> {
  AccountsOverview? _overview;
  String? _error;
  bool _loading = true;
  String _query = '';
  String? _expanded;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final overview = await ref.read(apiProvider).accountsOverview();
      if (!mounted) return;
      setState(() {
        _overview = overview;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _afterChange() async {
    await _load();
    await ref.read(dashboardProvider.notifier).refresh(force: true, silent: true);
  }

  List<PlatformOverview> get _filtered {
    final platforms = _overview?.providers ?? const <PlatformOverview>[];
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return platforms;
    return platforms
        .where((platform) =>
            '${platform.displayName} ${platform.id} ${platform.credentialHint}'.toLowerCase().contains(query))
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final runtime = ref.watch(runtimeProvider);
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 760;

    return Dialog(
      insetPadding: EdgeInsets.symmetric(horizontal: wide ? 40 : 12, vertical: 24),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 860, maxHeight: size.height * 0.86),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 16, 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('平台与账号', style: theme.textTheme.titleLarge),
                        const SizedBox(height: 4),
                        Text(
                          '登录或填写凭证，成功后自动写入本机配置',
                          style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            if (!runtime.canManageAccounts)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '移动端为只读看板：账号增删、密钥读取与登录请在本机客户端操作。',
                    style: theme.textTheme.labelSmall,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: TextField(
                decoration: const InputDecoration(
                  hintText: '筛选平台',
                  prefixIcon: Icon(Icons.search),
                ),
                onChanged: (value) => setState(() => _query = value),
              ),
            ),
            const SizedBox(height: 12),
            if (_loading)
              const LinearProgressIndicator(minHeight: 2)
            else if (_error != null)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text('读取平台清单失败：$_error', style: TextStyle(color: scheme.error)),
              ),
            Flexible(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 4, 24, 12),
                children: [
                  if (_filtered.isEmpty && !_loading)
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text('没有匹配的平台',
                          style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                    ),
                  for (final platform in _filtered) _buildPlatform(platform, runtime),
                  for (final warning in _overview?.warnings ?? const <String>[])
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(warning, style: theme.textTheme.labelSmall?.copyWith(color: scheme.error)),
                    ),
                  if ((_overview?.missingEnvVars ?? const []).isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        '缺少环境变量：${_overview!.missingEnvVars.join('、')}',
                        style: theme.textTheme.labelSmall?.copyWith(color: scheme.error),
                      ),
                    ),
                  if ((_overview?.accountsFilePath ?? '').isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        '账号文件：${_overview!.accountsFilePath}',
                        style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlatform(PlatformOverview platform, AppRuntime runtime) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final expanded = _expanded == platform.id;
    final registryMeta = ref.watch(registryMapProvider)[platform.id];
    final meta = platform.toMeta(loginMethods: registryMeta?.loginMethods ?? const []);
    final canManage = runtime.canManageAccounts && platform.manageAccounts;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.6)),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: canManage ? () => setState(() => _expanded = expanded ? null : platform.id) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(platform.displayName, style: theme.textTheme.titleSmall),
                            const SizedBox(width: 8),
                            Text(
                              platform.region == 'cn' ? '国内' : '国际',
                              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                            ),
                          ],
                        ),
                        if (platform.credentialHint.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              platform.credentialHint,
                              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (platform.accounts.isNotEmpty)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: scheme.secondaryContainer,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '${platform.accounts.length} 个账号',
                        style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSecondaryContainer),
                      ),
                    ),
                  if (canManage)
                    Icon(expanded ? Icons.expand_less : Icons.expand_more, color: scheme.onSurfaceVariant),
                ],
              ),
            ),
          ),
          if (canManage && expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Divider(),
                  const SizedBox(height: 8),
                  ManagePanel(
                    providerId: platform.id,
                    meta: meta,
                    onChanged: _afterChange,
                  ),
                ],
              ),
            )
          else if (!canManage && platform.accounts.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final account in platform.accounts)
                    Text(
                      '· ${account.label}${account.complete ? '' : '（缺凭证）'}',
                      style: theme.textTheme.labelSmall,
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
