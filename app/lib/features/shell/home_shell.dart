import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format/formatters.dart';
import '../../core/models/dashboard_logic.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import '../../state/providers.dart';
import '../accounts/platforms_dialog.dart';
import '../dashboard/dashboard_sections.dart';
import '../dashboard/provider_grid.dart';
import 'command_palette.dart';
import 'sections.dart';
import 'settings_sheet.dart';

class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  final ScrollController _scroll = ScrollController();
  final Map<DashboardSection, GlobalKey> _keys = {
    for (final section in DashboardSection.values) section: GlobalKey(),
  };

  DashboardSection _selected = DashboardSection.overview;
  bool _spyEnabled = true;
  double _lastScrollOffset = 0;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_spyEnabled) return;
    final offset = _scroll.offset;
    if ((offset - _lastScrollOffset).abs() < 8) return;
    _lastScrollOffset = offset;
    DashboardSection? next;
    for (final section in DashboardSection.values) {
      final context = _keys[section]?.currentContext;
      if (context == null) continue;
      final box = context.findRenderObject();
      if (box is! RenderBox || !box.hasSize) continue;
      final top = box.localToGlobal(Offset.zero).dy;
      if (top <= 160) next = section;
    }
    if (next != null && next != _selected) {
      final resolved = next;
      setState(() => _selected = resolved);
    }
  }

  Future<void> _goTo(DashboardSection section) async {
    setState(() {
      _selected = section;
      _spyEnabled = false;
    });
    final context = _keys[section]?.currentContext;
    if (context != null) {
      await Scrollable.ensureVisible(
        context,
        duration: const Duration(milliseconds: 320),
        curve: Curves.easeOutCubic,
        alignment: 0.02,
      );
    }
    await Future<void>.delayed(const Duration(milliseconds: 360));
    if (mounted) _spyEnabled = true;
  }

  void _filterByPlatform(String label) {
    ref.read(searchQueryProvider.notifier).state = label;
    _goTo(DashboardSection.providers);
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 1000;
    final payload = ref.watch(dashboardProvider);
    final data = payload.valueOrNull;

    final content = wide
        ? Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _SideRail(
                  selected: _selected,
                  data: data,
                  onSelect: _goTo,
                  onFilterPlatform: _filterByPlatform,
                  onOpenCommand: () => showCommandPalette(context, ref, onGoToSection: _goTo),
                ),
                const VerticalDivider(width: 1),
                Expanded(
                  child: Scaffold(
                    appBar: _buildAppBar(context, data, wide: true),
                    body: _buildBody(payload, data),
                  ),
                ),
              ],
            ),
          )
        : Scaffold(
            appBar: _buildAppBar(context, data, wide: false),
            body: _buildBody(payload, data),
            bottomNavigationBar: NavigationBar(
              selectedIndex: _selected.index,
              onDestinationSelected: (index) => _goTo(DashboardSection.values[index]),
              destinations: [
                for (final section in DashboardSection.values)
                  NavigationDestination(icon: Icon(section.icon), label: section.label),
              ],
            ),
          );

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
            showCommandPalette(context, ref, onGoToSection: _goTo),
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
            showCommandPalette(context, ref, onGoToSection: _goTo),
      },
      child: Focus(autofocus: true, child: content),
    );
  }

  PreferredSizeWidget _buildAppBar(BuildContext context, DashboardPayload? data, {required bool wide}) {
    final theme = Theme.of(context);
    final runtime = ref.watch(runtimeProvider);
    final loading = ref.watch(dashboardProvider).isLoading;
    final roomy = MediaQuery.sizeOf(context).width >= 1200;
    final totals = data?.totals;
    final failed = totals?.failed ?? 0;
    final tones = context.tones;

    return AppBar(
      toolbarHeight: wide ? 68 : 58,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(_selected.label),
          if (wide)
            Text(
              _selected.subtitle,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
        ],
      ),
      actions: [
        if (roomy && totals != null)
          Container(
            margin: const EdgeInsets.only(right: 8),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: failed > 0 ? tones.criticalContainer : theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  failed > 0 ? Icons.error_outline : Icons.check_circle_outline,
                  size: 14,
                  color: failed > 0 ? tones.critical : tones.success,
                ),
                const SizedBox(width: 6),
                Text(
                  '${totals.ok} 正常 / $failed 异常',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: failed > 0 ? tones.critical : theme.colorScheme.onSurface,
                  ),
                ),
              ],
            ),
          ),
        IconButton(
          tooltip: '搜索（⌘K / Ctrl+K）',
          onPressed: () => showCommandPalette(context, ref, onGoToSection: _goTo),
          icon: const Icon(Icons.search),
        ),
        if (wide)
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: OutlinedButton.icon(
              onPressed: () => showPlatformsDialog(context, ref),
              icon: const Icon(Icons.link, size: 18),
              label: const Text('平台与账号'),
            ),
          ),
        if (roomy)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('自动刷新', style: theme.textTheme.labelMedium),
              Switch(
                value: ref.watch(autoRefreshProvider),
                onChanged: (value) => ref.read(autoRefreshProvider.notifier).state = value,
              ),
            ],
          ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: wide
              ? FilledButton.icon(
                  onPressed: loading ? null : () => ref.read(dashboardProvider.notifier).refresh(),
                  icon: loading
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh, size: 18),
                  label: Text(loading ? '刷新中…' : '立即刷新'),
                )
              : IconButton(
                  tooltip: '立即刷新',
                  onPressed: loading ? null : () => ref.read(dashboardProvider.notifier).refresh(),
                  icon: loading
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh),
                ),
        ),
        IconButton(
          tooltip: '设置',
          onPressed: () => showSettingsSheet(context, ref),
          icon: const Icon(Icons.tune),
        ),
        if (!wide)
          PopupMenuButton<String>(
            tooltip: '更多',
            onSelected: (value) {
              switch (value) {
                case 'platforms':
                  showPlatformsDialog(context, ref);
                case 'command':
                  showCommandPalette(context, ref, onGoToSection: _goTo);
                case 'auto':
                  final notifier = ref.read(autoRefreshProvider.notifier);
                  notifier.state = !notifier.state;
                case 'settings':
                  showSettingsSheet(context, ref);
              }
            },
            itemBuilder: (context) => [
              const PopupMenuItem(value: 'platforms', child: Text('平台与账号')),
              const PopupMenuItem(value: 'command', child: Text('命令面板')),
              PopupMenuItem(
                value: 'auto',
                child: Text(ref.watch(autoRefreshProvider) ? '关闭自动刷新' : '开启自动刷新'),
              ),
              PopupMenuItem(
                value: 'settings',
                enabled: !runtime.isMobile,
                child: const Text('设置'),
              ),
            ],
          ),
        const SizedBox(width: 8),
      ],
    );
  }

  Widget _buildBody(AsyncValue<DashboardPayload> payload, DashboardPayload? data) {
    if (payload.hasError && data == null) {
      return _LoadError(error: payload.error!, onRetry: () => ref.read(dashboardProvider.notifier).refresh(force: false));
    }
    if (data == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return NotificationListener<ScrollNotification>(
      onNotification: (_) => false,
      child: ListView(
        controller: _scroll,
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
        children: [
          DashboardSummarySection(key: _keys[DashboardSection.overview], payload: data),
          const SizedBox(height: 16),
          ExpiryAlertBanner(payload: data),
          const SizedBox(height: 16),
          const DashboardToolbar(),
          const SizedBox(height: 16),
          ProviderGrid(key: _keys[DashboardSection.providers]),
          const SizedBox(height: 24),
          ExpiryTimelineSection(key: _keys[DashboardSection.timeline], payload: data),
          const SizedBox(height: 24),
          DiagnosticsSection(key: _keys[DashboardSection.diagnostics], payload: data),
          const SizedBox(height: 24),
          const DashboardFooter(),
        ],
      ),
    );
  }
}

class _SideRail extends ConsumerWidget {
  const _SideRail({
    required this.selected,
    required this.data,
    required this.onSelect,
    required this.onFilterPlatform,
    required this.onOpenCommand,
  });

  final DashboardSection selected;
  final DashboardPayload? data;
  final ValueChanged<DashboardSection> onSelect;
  final ValueChanged<String> onFilterPlatform;
  final VoidCallback onOpenCommand;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final groups = ref.watch(platformGroupsProvider);
    final registry = ref.watch(registryMapProvider);
    final thresholds = data?.expiryThresholds ?? const ExpiryThresholds();
    final query = ref.watch(searchQueryProvider);
    final visible = ref.watch(visibleProvidersProvider);
    final diagCount = data == null ? 0 : countDiagnostics(data!);

    int badgeOf(DashboardSection section) => switch (section) {
          DashboardSection.overview => data?.totals.providers ?? 0,
          DashboardSection.providers => visible.length,
          DashboardSection.timeline => data?.expiryTimeline.length ?? 0,
          DashboardSection.diagnostics => diagCount,
        };

    return Container(
      width: 268,
      color: scheme.surfaceContainerLow,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
              child: Row(
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: scheme.primaryContainer,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(Icons.bolt_rounded, color: scheme.onPrimaryContainer),
                  ),
                  const SizedBox(width: 12),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Power Meter', style: theme.textTheme.titleMedium),
                      Text(
                        '多平台额度看板',
                        style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                children: [
                  for (final section in DashboardSection.values)
                    _NavTile(
                      icon: section.icon,
                      label: section.label,
                      badge: badgeOf(section),
                      danger: section == DashboardSection.diagnostics && diagCount > 0,
                      selected: selected == section,
                      onTap: () => onSelect(section),
                    ),
                  const SizedBox(height: 8),
                  const Divider(),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
                    child: Text(
                      '按平台',
                      style: theme.textTheme.labelMedium?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ),
                  if (groups.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: Text('暂无平台数据',
                          style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                    )
                  else ...[
                    _PlatformRow(
                      label: '全部平台',
                      amount: '${groups.length} 个',
                      level: groupUrgency(groups.expand((group) => group.members).toList(), thresholds),
                      active: query.trim().isEmpty,
                      onTap: () => onFilterPlatform(''),
                    ),
                    for (final group in groups)
                      _PlatformRow(
                        label: group.label,
                        amount: groupBalance(group.members) == null
                            ? '—'
                            : fmtNumber(groupBalance(group.members)),
                        level: groupUrgency(group.members, thresholds),
                        active: query.trim() == group.label,
                        onTap: () => onFilterPlatform(group.label),
                      ),
                  ],
                  const SizedBox(height: 12),
                  if (registry.isEmpty && data != null)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text('平台清单加载中…',
                          style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
                    ),
                ],
              ),
            ),
            const Divider(),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  OutlinedButton.icon(
                    onPressed: onOpenCommand,
                    icon: const Icon(Icons.search, size: 18),
                    label: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('命令面板'),
                        SizedBox(width: 8),
                        _Kbd('⌘K'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    data?.generatedAt == null ? '等待数据' : '更新于 ${fmtDate(data!.generatedAt)}',
                    style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
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

class _NavTile extends StatelessWidget {
  const _NavTile({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.badge,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final int? badge;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tones = context.tones;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color: selected ? scheme.secondaryContainer : Colors.transparent,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Icon(
                  icon,
                  size: 20,
                  color: selected ? scheme.onSecondaryContainer : scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: selected ? scheme.onSecondaryContainer : scheme.onSurface,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                        ),
                  ),
                ),
                if (badge != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: danger ? tones.criticalContainer : scheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      '$badge',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: danger ? tones.critical : scheme.onSurfaceVariant,
                          ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PlatformRow extends StatelessWidget {
  const _PlatformRow({
    required this.label,
    required this.amount,
    required this.level,
    required this.active,
    required this.onTap,
  });

  final String label;
  final String amount;
  final ExpiryLevel level;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: active ? scheme.primaryContainer.withValues(alpha: 0.6) : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          child: Row(
            children: [
              _StatusDot(level: level),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              Text(
                amount,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      fontFeatures: const [FontFeature.tabularFigures()],
                      color: amount == '—' ? scheme.onSurfaceVariant : scheme.onSurface,
                    ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.level});

  final ExpiryLevel level;

  @override
  Widget build(BuildContext context) {
    final color = context.toneForExpiry(level);
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

class _Kbd extends StatelessWidget {
  const _Kbd(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Text(text, style: Theme.of(context).textTheme.labelSmall),
    );
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 40, color: scheme.error),
            const SizedBox(height: 12),
            Text('加载失败', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text('$error', textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}
