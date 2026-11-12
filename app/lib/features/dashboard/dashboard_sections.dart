import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format/formatters.dart';
import '../../core/models/dashboard_logic.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import '../../state/providers.dart';

class DashboardSummarySection extends StatelessWidget {
  const DashboardSummarySection({super.key, required this.payload});

  final DashboardPayload payload;

  @override
  Widget build(BuildContext context) {
    final available = payload.totals.availableByCurrency.entries
        .where((entry) => entry.value > 0)
        .toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final critical = criticalHits(payload);
    final warning = warningHits(payload);

    final stats = <_StatData>[
      _StatData(
        label: '平台总数',
        value: '${payload.totals.providers}',
        hint: '${payload.totals.ok} 正常 / ${payload.totals.failed} 异常',
      ),
      _StatData(
        label: '可用额度合计',
        rows: available.isEmpty
            ? [('', '–')]
            : [for (final entry in available) (entry.key, fmtNumber(entry.value))],
        hint: '各币种余额独立汇总，数值之间互不换算',
      ),
      _StatData(
        label: '≤${payload.expiryThresholds.criticalDays} 天到期',
        value: '$critical',
        hint: '${payload.expiryThresholds.criticalDays}~${payload.expiryThresholds.warningDays} 天内还有 $warning 笔',
        accent: critical > 0,
      ),
      _StatData(
        label: '到期批次总数',
        value: '${payload.expiryTimeline.length}',
        hint: '只统计仍可用的积分批次',
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 1000
            ? 4
            : constraints.maxWidth >= 640
                ? 2
                : 1;
        const spacing = 12.0;
        final width = (constraints.maxWidth - spacing * (columns - 1)) / columns;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final stat in stats) SizedBox(width: width, child: _StatCard(data: stat)),
          ],
        );
      },
    );
  }
}

class _StatData {
  const _StatData({required this.label, this.value, this.rows, required this.hint, this.accent = false});

  final String label;
  final String? value;
  final List<(String, String)>? rows;
  final String hint;
  final bool accent;
}

class _StatCard extends StatelessWidget {
  const _StatCard({required this.data});

  final _StatData data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Card(
      color: data.accent ? scheme.errorContainer.withValues(alpha: 0.45) : null,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              data.label,
              style: theme.textTheme.labelMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 8),
            if (data.rows != null)
              ...data.rows!.map(
                (row) => Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          row.$1,
                          style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ),
                      Text(
                        row.$2,
                        style: theme.textTheme.headlineSmall?.copyWith(
                          color: data.accent ? scheme.error : scheme.onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
              )
            else
              Text(data.value ?? '–', style: theme.textTheme.displaySmall),
            const SizedBox(height: 8),
            Text(
              data.hint,
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class ExpiryAlertBanner extends StatelessWidget {
  const ExpiryAlertBanner({super.key, required this.payload});

  final DashboardPayload payload;

  @override
  Widget build(BuildContext context) {
    final next = payload.nextExpiry;
    if (next == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final level = levelFor(
      next.inDays,
      criticalDays: payload.expiryThresholds.criticalDays,
      warningDays: payload.expiryThresholds.warningDays,
    );
    final color = context.toneForExpiry(level);
    final background = context.toneContainerForExpiry(level);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            level == ExpiryLevel.critical ? Icons.local_fire_department : Icons.hourglass_bottom,
            color: color,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '最快到期：${next.displayName} · ${next.lotLabel}',
                  style: theme.textTheme.titleSmall?.copyWith(color: color, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                Text(
                  '${fmtNumber(next.amount)} ${next.currency} 将于 ${fmtDate(next.expiresAt)} 到期'
                  '（${expiryText(next.inDays)}），建议优先使用。',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurface),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class DashboardToolbar extends ConsumerStatefulWidget {
  const DashboardToolbar({super.key});

  @override
  ConsumerState<DashboardToolbar> createState() => _DashboardToolbarState();
}

class _DashboardToolbarState extends ConsumerState<DashboardToolbar> {
  late final TextEditingController _search;

  @override
  void initState() {
    super.initState();
    _search = TextEditingController(text: ref.read(searchQueryProvider));
    // 「按平台」子菜单 / 命令面板也会改筛选词，输入框必须跟着同步。
    ref.listenManual(searchQueryProvider, (previous, next) {
      if (_search.text != next) {
        _search.text = next;
        _search.selection = TextSelection.collapsed(offset: next.length);
      }
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sort = ref.watch(sortModeProvider);
    final groups = ref.watch(platformGroupsProvider);
    final payload = ref.watch(dashboardProvider).valueOrNull;
    final visible = ref.watch(visibleProvidersProvider);
    final total = payload?.providers.length ?? 0;
    final thresholds = payload?.expiryThresholds ?? const ExpiryThresholds();
    final riskCount = payload == null
        ? 0
        : payload.providers.where((item) => urgencyOf(item, thresholds) != ExpiryLevel.safe).length;

    final search = SearchBar(
      controller: _search,
      hintText: '平台名 / 批次 / 币种',
      leading: const Icon(Icons.search),
      trailing: [
        if (_search.text.isNotEmpty)
          IconButton(
            tooltip: '清除筛选',
            onPressed: () {
              _search.clear();
              ref.read(searchQueryProvider.notifier).state = '';
            },
            icon: const Icon(Icons.close, size: 18),
          ),
      ],
      onChanged: (value) => ref.read(searchQueryProvider.notifier).state = value,
      elevation: const WidgetStatePropertyAll(0),
      padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 14)),
      constraints: const BoxConstraints(minHeight: 44, maxHeight: 44),
    );

    final sortMenu = DropdownMenu<SortMode>(
      width: 220,
      initialSelection: sort,
      label: const Text('排序'),
      onSelected: (value) {
        if (value != null) ref.read(sortModeProvider.notifier).state = value;
      },
      dropdownMenuEntries: [
        for (final mode in SortMode.values)
          DropdownMenuEntry(
            value: mode,
            label: mode == SortMode.risk ? '仅看有到期风险的（$riskCount）' : mode.label,
          ),
      ],
    );

    final meta = Text(
      '显示 ${visible.length} / $total 个平台 · ${groups.length} 个平台分组',
      style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 760) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              search,
              const SizedBox(height: 10),
              Row(
                children: [
                  sortMenu,
                  const Spacer(),
                ],
              ),
              const SizedBox(height: 6),
              meta,
            ],
          );
        }
        return Row(
          children: [
            sortMenu,
            const SizedBox(width: 12),
            SizedBox(width: 360, child: search),
            const Spacer(),
            meta,
          ],
        );
      },
    );
  }
}

class ExpiryTimelineSection extends StatelessWidget {
  const ExpiryTimelineSection({super.key, required this.payload});

  final DashboardPayload payload;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final hits = payload.expiryTimeline;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('到期时间线', style: theme.textTheme.titleMedium),
                const SizedBox(width: 10),
                Text(
                  '按过期时间升序，优先消耗排在最前面的积分',
                  style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (hits.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text('暂无可用的到期信息',
                    style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
              )
            else
              for (var index = 0; index < hits.length; index++) ...[
                if (index > 0) const Divider(height: 1),
                _TimelineRow(hit: hits[index], thresholds: payload.expiryThresholds),
              ],
          ],
        ),
      ),
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.hit, required this.thresholds});

  final ExpiryHit hit;
  final ExpiryThresholds thresholds;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final level = levelFor(
      hit.inDays,
      criticalDays: thresholds.criticalDays,
      warningDays: thresholds.warningDays,
    );
    final color = context.toneForExpiry(level);
    final cny = hit.cny;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 3,
            height: 38,
            margin: const EdgeInsets.only(top: 2, right: 12),
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
          ),
          SizedBox(
            width: 128,
            child: Text(
              fmtDate(hit.expiresAt),
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${hit.displayName} · ${hit.lotLabel}', style: theme.textTheme.bodyMedium),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Text(
                      '${fmtNumber(hit.amount)} ${hit.currency}',
                      style: theme.textTheme.labelMedium,
                    ),
                    if (cny != null) ...[
                      const SizedBox(width: 8),
                      Tooltip(
                        message: hit.cnyNote ?? '',
                        child: Text(
                          '≈ ${fmtCny(cny)}',
                          style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: context.toneContainerForExpiry(level),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              expiryText(hit.inDays),
              style: theme.textTheme.labelSmall?.copyWith(color: color),
            ),
          ),
        ],
      ),
    );
  }
}

class DiagnosticsSection extends StatelessWidget {
  const DiagnosticsSection({super.key, required this.payload});

  final DashboardPayload payload;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final items = <({bool warn, String text})>[
      for (final variable in payload.missingEnvVars)
        (
          warn: true,
          text: '环境变量 $variable 为空，相关平台的凭证引用会解析成空值。请在 .env 中补齐后重新刷新。',
        ),
      for (final warning in payload.warnings) (warn: true, text: warning),
      for (final provider in payload.providers)
        if (!provider.healthy)
          (
            warn: provider.status != 'notConfigured',
            text: '【${provider.displayName}】${provider.status}：${provider.message ?? '未提供原因'}',
          ),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('诊断', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              '凭证与配置问题会在这里提示',
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            if (items.isEmpty)
              Row(
                children: [
                  Icon(Icons.check_circle_outline, size: 18, color: context.tones.success),
                  const SizedBox(width: 8),
                  Text('一切正常，没有需要处理的配置问题。', style: theme.textTheme.bodySmall),
                ],
              )
            else
              for (final item in items)
                Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: item.warn
                        ? context.tones.warningContainer.withValues(alpha: 0.5)
                        : scheme.surfaceContainerHighest.withValues(alpha: 0.5),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        item.warn ? Icons.warning_amber_rounded : Icons.info_outline,
                        size: 18,
                        color: item.warn ? context.tones.warning : scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(item.text, style: theme.textTheme.bodySmall)),
                    ],
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

class DashboardFooter extends StatelessWidget {
  const DashboardFooter({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '凭证默认只留在本机；仅在点击「显示 / 复制」时按需读取，且只允许本机访问。',
              style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ),
          Text(
            'Power Meter · Flutter',
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
