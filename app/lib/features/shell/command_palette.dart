import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../accounts/platforms_dialog.dart';
import 'sections.dart';
import 'settings_sheet.dart';

/// 命令面板（⌘K / Ctrl+K）：跳转区块、按平台筛选、执行常用动作。
Future<void> showCommandPalette(
  BuildContext context,
  WidgetRef ref, {
  required ValueChanged<DashboardSection> onGoToSection,
}) {
  final host = context;
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black54,
    builder: (context) => _CommandPalette(hostContext: host, onGoToSection: onGoToSection),
  );
}

class _CommandItem {
  _CommandItem({
    required this.label,
    required this.subtitle,
    required this.icon,
    required this.keywords,
    required this.run,
  });

  final String label;
  final String subtitle;
  final IconData icon;
  final String keywords;
  final Future<void> Function() run;

  bool matches(String query) {
    final normalized = query.trim().toLowerCase();
    if (normalized.isEmpty) return true;
    return '$label $subtitle $keywords'.toLowerCase().contains(normalized);
  }
}

class _CommandPalette extends ConsumerStatefulWidget {
  const _CommandPalette({required this.hostContext, required this.onGoToSection});

  final BuildContext hostContext;
  final ValueChanged<DashboardSection> onGoToSection;

  @override
  ConsumerState<_CommandPalette> createState() => _CommandPaletteState();
}

class _CommandPaletteState extends ConsumerState<_CommandPalette> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  int _index = 0;
  late final List<_CommandItem> _items = _buildItems();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focusNode.requestFocus());
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  List<_CommandItem> _buildItems() {
    final groups = ref.read(platformGroupsProvider);
    final runtime = ref.read(runtimeProvider);
    return [
      for (final section in DashboardSection.values)
        _CommandItem(
          label: section.label,
          subtitle: section.subtitle,
          icon: section.icon,
          keywords: '导航 区块 section',
          run: () async {
            Navigator.of(context).pop();
            widget.onGoToSection(section);
          },
        ),
      _CommandItem(
        label: '立即刷新',
        subtitle: '强制重新取数并重读配置',
        icon: Icons.refresh,
        keywords: 'refresh 刷新 更新',
        run: () async {
          Navigator.of(context).pop();
          await ref.read(dashboardProvider.notifier).refresh();
        },
      ),
      if (runtime.canManageAccounts)
        _CommandItem(
          label: '平台与账号',
          subtitle: '登录、添加或删除账号',
          icon: Icons.link,
          keywords: 'accounts 账号 登录 平台',
          run: () async {
            Navigator.of(context).pop();
            await showPlatformsDialog(widget.hostContext, ref);
          },
        ),
      _CommandItem(
        label: '设置',
        subtitle: '主题、服务地址与运行信息',
        icon: Icons.tune,
        keywords: 'settings 设置 主题',
        run: () async {
          Navigator.of(context).pop();
          await showSettingsSheet(widget.hostContext, ref);
        },
      ),
      for (final group in groups)
        _CommandItem(
          label: group.label,
          subtitle: '按平台筛选卡片',
          icon: Icons.filter_alt_outlined,
          keywords: '平台 ${group.provider}',
          run: () async {
            ref.read(searchQueryProvider.notifier).state = group.label;
            Navigator.of(context).pop();
            widget.onGoToSection(DashboardSection.providers);
          },
        ),
    ];
  }

  List<_CommandItem> get _filtered => _items.where((item) => item.matches(_controller.text)).toList();

  void _move(int delta) {
    final items = _filtered;
    if (items.isEmpty) return;
    setState(() => _index = (_index + delta).clamp(0, items.length - 1));
  }

  Future<void> _runSelected() async {
    final items = _filtered;
    if (items.isEmpty) return;
    await items[_index.clamp(0, items.length - 1)].run();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    switch (event.logicalKey) {
      case LogicalKeyboardKey.arrowDown:
        _move(1);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.arrowUp:
        _move(-1);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.enter:
      case LogicalKeyboardKey.numpadEnter:
        _runSelected();
        return KeyEventResult.handled;
      case LogicalKeyboardKey.escape:
        Navigator.of(context).pop();
        return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final items = _filtered;
    if (_index >= items.length) _index = 0;

    return Dialog(
      alignment: Alignment.topCenter,
      insetPadding: const EdgeInsets.only(top: 96, left: 24, right: 24, bottom: 24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 520),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
              child: Focus(
                onKeyEvent: _onKey,
                child: TextField(
                  controller: _controller,
                  focusNode: _focusNode,
                  autofocus: true,
                  decoration: const InputDecoration(
                    hintText: '搜索平台、跳转区块或执行命令…',
                    prefixIcon: Icon(Icons.search),
                    border: InputBorder.none,
                    filled: false,
                  ),
                  onChanged: (_) => setState(() => _index = 0),
                  onSubmitted: (_) => _runSelected(),
                ),
              ),
            ),
            const Divider(height: 1),
            Flexible(
              child: items.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        '没有匹配的结果',
                        style: theme.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: items.length,
                      itemBuilder: (context, index) {
                        final item = items[index];
                        final selected = index == _index;
                        return ListTile(
                          selected: selected,
                          leading: Icon(item.icon, size: 20),
                          title: Text(item.label),
                          subtitle: Text(item.subtitle),
                          dense: true,
                          onTap: () => item.run(),
                          onFocusChange: (hasFocus) {
                            if (hasFocus) setState(() => _index = index);
                          },
                        );
                      },
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                children: [
                  _Hint(kbd: '↑ ↓', text: '选择'),
                  const SizedBox(width: 14),
                  _Hint(kbd: '↵', text: '执行'),
                  const SizedBox(width: 14),
                  _Hint(kbd: 'Esc', text: '关闭'),
                  const Spacer(),
                  Text(
                    '${items.length} 项',
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

class _Hint extends StatelessWidget {
  const _Hint({required this.kbd, required this.text});

  final String kbd;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(5),
            border: Border.all(color: scheme.outlineVariant),
          ),
          child: Text(kbd, style: Theme.of(context).textTheme.labelSmall),
        ),
        const SizedBox(width: 5),
        Text(text, style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}
