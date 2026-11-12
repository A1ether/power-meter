import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/format/formatters.dart';
import '../../core/models/dashboard_logic.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import '../../state/providers.dart';
import '../accounts/manage_panel.dart';
import '../accounts/secret_tile.dart';

const int _visibleLots = 3;
const int _visibleEntries = 2;

class ProviderCard extends ConsumerStatefulWidget {
  const ProviderCard({super.key, required this.provider, required this.thresholds});

  final ProviderSnapshot provider;
  final ExpiryThresholds thresholds;

  @override
  ConsumerState<ProviderCard> createState() => _ProviderCardState();
}

class _ProviderCardState extends ConsumerState<ProviderCard> {
  bool _manageOpen = false;
  bool _lotsExpanded = false;
  bool _entriesExpanded = false;
  bool _deleting = false;

  ProviderSnapshot get provider => widget.provider;

  Future<void> _refreshDashboard() async {
    // 增删账号 / 登录落库后必须强制重新读配置与取数，避免返回旧缓存。
    await ref.read(dashboardProvider.notifier).refresh(force: true, silent: true);
  }

  Future<void> _removeAccount(String accountId, String label) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除账号'),
        content: Text('确定删除「$label」吗？\n会同时清理 .env 中不再被引用的变量，改动前自动备份到 .run/。'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _deleting = true);
    try {
      await ref.read(apiProvider).removeAccount(provider: provider.provider, accountId: accountId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已删除「$label」')));
      await _refreshDashboard();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败：$error')));
    } finally {
      if (mounted) setState(() => _deleting = false);
    }
  }

  Future<void> _openUrl(String url) async {
    if (url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tones = context.tones;
    final meta = ref.watch(registryMapProvider)[provider.provider];
    final canManage = ref.watch(runtimeProvider).canManageAccounts;
    final healthy = provider.healthy;
    final grouped = provider.groupAccounts || provider.entries.isNotEmpty;
    final showManage = canManage && meta != null && meta.manageAccounts;

    final expiryLevel = provider.nextExpiryInDays == null
        ? ExpiryLevel.none
        : levelFor(
            provider.nextExpiryInDays,
            criticalDays: widget.thresholds.criticalDays,
            warningDays: widget.thresholds.warningDays,
          );

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Container(
                    width: 9,
                    height: 9,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: healthy ? tones.success : scheme.error,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(provider.displayName, style: theme.textTheme.titleMedium),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        children: [
                          _Pill(
                            text: provider.region == 'cn' ? '国内' : '国际',
                            foreground: scheme.onSurfaceVariant,
                            background: scheme.surfaceContainerHighest,
                          ),
                          if (provider.status == 'demo')
                            _Pill(
                              text: '示例数据',
                              foreground: scheme.onTertiaryContainer,
                              background: scheme.tertiaryContainer,
                            ),
                          if (provider.stale)
                            _Pill(
                              text: '数据可能过期',
                              foreground: tones.warning,
                              background: tones.warningContainer,
                            ),
                          if (provider.neverExpires)
                            _Pill(
                              text: '永不过期',
                              foreground: tones.success,
                              background: tones.successContainer,
                            )
                          else if (provider.nextExpiryInDays != null)
                            _Pill(
                              text: expiryText(provider.nextExpiryInDays),
                              foreground: context.toneForExpiry(expiryLevel),
                              background: context.toneContainerForExpiry(expiryLevel),
                            ),
                          if (!healthy)
                            _Pill(
                              text: provider.status,
                              foreground: tones.critical,
                              background: tones.criticalContainer,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  healthy ? fmtNumber(provider.balanceAmount) : '—',
                  style: theme.textTheme.displaySmall,
                ),
                const SizedBox(width: 8),
                Padding(
                  padding: const EdgeInsets.only(bottom: 5),
                  child: Text(
                    healthy ? provider.currency : '',
                    style: theme.textTheme.labelLarge?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
                const Spacer(),
                if (showManage)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (grouped)
                        TextButton.icon(
                          onPressed: () => setState(() => _manageOpen = !_manageOpen),
                          icon: Icon(_manageOpen ? Icons.expand_less : Icons.add),
                          label: Text(_manageOpen ? '收起' : '添加账号'),
                        )
                      else if (meta.hasLogin)
                        TextButton(
                          onPressed: () => setState(() => _manageOpen = !_manageOpen),
                          child: Text(_manageOpen ? '收起' : '重新登录'),
                        ),
                      if (!grouped)
                        IconButton(
                          tooltip: '删除账号',
                          onPressed: _deleting
                              ? null
                              : () => _removeAccount(
                                    provider.accountId,
                                    provider.displayName.isEmpty ? '未命名账号' : provider.displayName,
                                  ),
                          icon: _deleting
                              ? const SizedBox.square(
                                  dimension: 18,
                                  child: CircularProgressIndicator(strokeWidth: 2),
                                )
                              : Icon(Icons.delete_outline, color: scheme.error),
                        ),
                    ],
                  ),
              ],
            ),
            if (provider.plan != null && provider.plan!.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                [provider.plan, if (provider.source == 'local') '本地示例'].whereType<String>().join(' · '),
                style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
            if (healthy && provider.dailyUsage != null) ...[
              const SizedBox(height: 12),
              _UsageGrid(provider: provider, onOpen: _openUrl),
            ],
            if (healthy && provider.entries.isEmpty) ...[
              ..._buildMeter(context),
              const SizedBox(height: 12),
              _buildLots(context),
            ],
            if (provider.entries.isNotEmpty) ...[
              const SizedBox(height: 12),
              _buildEntries(context),
            ],
            if (provider.secrets.isNotEmpty && provider.entries.isEmpty) ...[
              const SizedBox(height: 14),
              _SectionHeader(title: '托管密钥', hint: '仅本机可读 · 点击复制'),
              const SizedBox(height: 8),
              for (final secret in provider.secrets)
                SecretTile(
                  provider: provider.provider,
                  accountId: provider.accountId,
                  secret: secret,
                  enabled: canManage,
                ),
            ],
            if (showManage && _manageOpen) ...[
              const SizedBox(height: 12),
              ManagePanel(
                providerId: provider.provider,
                meta: meta,
                targetAccountId: grouped ? null : provider.accountId,
                onChanged: _refreshDashboard,
              ),
            ],
            if (provider.note != null && provider.note!.isNotEmpty && healthy) ...[
              const SizedBox(height: 12),
              Text(provider.note!, style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
            ],
            const SizedBox(height: 12),
            const Divider(),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(
                    provider.updatedAt == null ? '等待首次取数' : '更新于 ${fmtDate(provider.updatedAt)}',
                    style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
                if (provider.dashboardUrl.isNotEmpty)
                  TextButton(
                    onPressed: () => _openUrl(provider.dashboardUrl),
                    child: const Text('打开面板 ↗'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildMeter(BuildContext context) {
    final meters = provider.windows.where((item) => item.showMeter);
    if (meters.isEmpty || !provider.healthy) return const [];
    final window = meters.first;
    final theme = Theme.of(context);
    final remainingPercent = window.limit <= 0 ? 0.0 : (window.remaining / window.limit).clamp(0.0, 1.0);
    return [
      const SizedBox(height: 12),
      ClipRRect(
        borderRadius: BorderRadius.circular(999),
        child: LinearProgressIndicator(
          value: remainingPercent,
          minHeight: 7,
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
        ),
      ),
      const SizedBox(height: 6),
      Row(
        children: [
          Expanded(child: Text(window.label, style: theme.textTheme.labelSmall)),
          Text(
            '剩余 ${fmtNumber(window.remaining)} / ${fmtNumber(window.limit)}'
            '${window.resetsAt == null ? '' : ' · ${fmtDate(window.resetsAt)} 重置'}',
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    ];
  }

  Widget _buildLots(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final lots = sortedLots(provider.credits);
    if (lots.isEmpty) {
      return Text(
        '该平台目前没有可用的积分批次',
        style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
      );
    }
    final visible = _lotsExpanded ? lots : lots.take(_visibleLots).toList();
    final hidden = lots.length - _visibleLots;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text('可用积分批次', style: theme.textTheme.labelMedium),
            const Spacer(),
            Text('过期 / 剩余', style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
          ],
        ),
        const SizedBox(height: 6),
        for (final lot in visible) _LotRow(lot: lot, thresholds: widget.thresholds),
        if (hidden > 0)
          TextButton(
            onPressed: () => setState(() => _lotsExpanded = !_lotsExpanded),
            child: Text(_lotsExpanded ? '收起 ⌃' : '展开其余 $hidden 个 ⌄'),
          ),
      ],
    );
  }

  Widget _buildEntries(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final entries = _entriesExpanded ? provider.entries : provider.entries.take(_visibleEntries).toList();
    final hidden = provider.entries.length - _visibleEntries;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text('账号 · 托管密钥', style: theme.textTheme.labelMedium),
            const Spacer(),
            Text('可用额度', style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
          ],
        ),
        const SizedBox(height: 6),
        for (final entry in entries)
          _EntryRow(
            provider: provider,
            entry: entry,
            canManage: ref.watch(runtimeProvider).canManageAccounts && provider.manageAccounts,
            canReveal: ref.watch(runtimeProvider).canManageAccounts,
            onRemove: () => _removeAccount(entry.id, entry.label.isEmpty ? '未命名账号' : entry.label),
          ),
        if (hidden > 0)
          TextButton(
            onPressed: () => setState(() => _entriesExpanded = !_entriesExpanded),
            child: Text(_entriesExpanded ? '收起 ⌃' : '展开其余 $hidden 个 ⌄'),
          ),
      ],
    );
  }
}

class _LotRow extends StatelessWidget {
  const _LotRow({required this.lot, required this.thresholds});

  final CreditLot lot;
  final ExpiryThresholds thresholds;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final days = daysUntil(lot.expiresAt);
    final level = levelFor(
      days,
      criticalDays: thresholds.criticalDays,
      warningDays: thresholds.warningDays,
    );
    return Tooltip(
      message: lot.note,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 3,
              height: 34,
              margin: const EdgeInsets.only(top: 2, right: 9),
              decoration: BoxDecoration(
                color: context.toneForExpiry(level),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Expanded(
              child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    lot.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
                Text(
                  '${fmtNumber(lot.amount)} ${lot.currency}${lot.isGranted ? ' 授予量' : ''}',
                  style: theme.textTheme.labelMedium,
                ),
              ],
            ),
            const SizedBox(height: 2),
            Row(
              children: [
                Expanded(
                  child: Text(
                    lot.expiresAt == null ? '不过期' : '过期：${fmtDate(lot.expiresAt)}',
                    style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
                Text(
                  expiryText(days),
                  style: theme.textTheme.labelSmall?.copyWith(color: context.toneForExpiry(level)),
                ),
              ],
            ),
          ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EntryRow extends StatelessWidget {
  const _EntryRow({
    required this.provider,
    required this.entry,
    required this.canManage,
    required this.canReveal,
    required this.onRemove,
  });

  final ProviderSnapshot provider;
  final ProviderEntry entry;
  final bool canManage;
  final bool canReveal;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final healthy = entry.healthy;
    final empty = healthy && entry.amount <= 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  entry.label.isEmpty ? '(未命名账号)' : entry.label,
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                healthy ? '${fmtNumber(entry.amount)} ${entry.currency}' : entry.status,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: healthy && !empty ? scheme.onSurface : scheme.error,
                ),
              ),
              if (canManage)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: '删除账号',
                  onPressed: onRemove,
                  icon: Icon(Icons.delete_outline, size: 18, color: scheme.error),
                ),
            ],
          ),
          if (empty)
            Text('quota 已用尽，该账号调不动',
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.error)),
          if (!healthy && entry.message != null)
            Text(entry.message!, style: theme.textTheme.labelSmall?.copyWith(color: scheme.error)),
          if (entry.secrets.isEmpty)
            Text('未配置可托管的项目密钥',
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant))
          else
            for (final secret in entry.secrets)
              SecretTile(
                provider: provider.provider,
                accountId: entry.id,
                secret: secret,
                enabled: canReveal,
              ),
          if (healthy && entry.note != null)
            Text(entry.note!, style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _UsageGrid extends StatelessWidget {
  const _UsageGrid({required this.provider, required this.onOpen});

  final ProviderSnapshot provider;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final usage = provider.dailyUsage!;
    final currency = usage.currency;

    double? valueOf(String key) => switch (key) {
          'todayUsed' => usage.todayUsed,
          'yesterdayUsed' => usage.yesterdayUsed,
          'todayAdded' => usage.todayAdded,
          'yesterdayAdded' => usage.yesterdayAdded,
          _ => null,
        };

    final content = Column(
      children: [
        for (var row = 0; row < 2; row++)
          Row(
            children: [
              for (var column = 0; column < 2; column++)
                Expanded(
                  child: _UsageItem(
                    field: usageFields[row * 2 + column],
                    value: valueOf(usageFields[row * 2 + column].key),
                    currency: currency,
                    source: usage.sources.forField(usageFields[row * 2 + column].key),
                  ),
                ),
            ],
          ),
      ],
    );

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        children: [
          if (provider.usageUrl.isNotEmpty)
            InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => onOpen(provider.usageUrl),
              child: Row(
                children: [
                  Text('每日用量', style: theme.textTheme.labelMedium),
                  const Spacer(),
                  Icon(Icons.open_in_new, size: 13, color: scheme.onSurfaceVariant),
                ],
              ),
            )
          else
            Row(
              children: [Text('每日用量', style: theme.textTheme.labelMedium)],
            ),
          const SizedBox(height: 6),
          content,
        ],
      ),
    );
  }
}

class _UsageItem extends StatelessWidget {
  const _UsageItem({
    required this.field,
    required this.value,
    required this.currency,
    required this.source,
  });

  final UsageField field;
  final double? value;
  final String currency;
  final String source;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tones = context.tones;
    final sourceLabel = usageSourceLabels[source] ?? usageSourceLabels['local']!;
    final text = value == null
        ? '–'
        : '${field.increase && value! > 0 ? '+' : ''}${fmtNumber(value)} $currency';
    final color = value == null
        ? scheme.onSurfaceVariant
        : !field.increase
            ? scheme.onSurface
            : value! > 0
                ? tones.success
                : value! < 0
                    ? tones.critical
                    : scheme.onSurfaceVariant;
    return Tooltip(
      message: value == null
          ? '${field.label}：暂无数据（$sourceLabel）'
          : '${field.label}：$text（${field.hint}；$sourceLabel）',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(field.label,
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
            Text(text, style: theme.textTheme.labelMedium?.copyWith(color: color)),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, required this.hint});

  final String title;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Text(title, style: theme.textTheme.labelMedium),
        const Spacer(),
        Text(hint, style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.foreground, required this.background});

  final String text;
  final Color foreground;
  final Color background;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: foreground)),
    );
  }
}
