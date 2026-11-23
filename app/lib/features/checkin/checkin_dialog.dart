import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import '../../state/providers.dart';

/// 「每日签到」弹窗：自动签到设置、一键签到、逐账号结果。
///
/// 交互与 Web 看板对齐（`public/app.js:831-1100`）：
/// - 只展示「支持签到」的账号；停用账号给出原因。
/// - 今日已领取 / 已签到的账号按钮置灰，不重复请求。
/// - 领取成功才刷新看板余额，失败只就地提示。
Future<void> showCheckinDialog(BuildContext context, WidgetRef ref) {
  return showDialog<void>(
    context: context,
    builder: (_) => const CheckinDialog(),
  );
}

class CheckinDialog extends ConsumerStatefulWidget {
  const CheckinDialog({super.key});

  @override
  ConsumerState<CheckinDialog> createState() => _CheckinDialogState();
}

class _CheckinDialogState extends ConsumerState<CheckinDialog> {
  ({String text, bool ok})? _message;
  bool _savingSettings = false;

  @override
  void initState() {
    super.initState();
    // 每次打开都重读状态，避免展示上一次会话的旧结果；放到首帧后避免 build 期间改 provider。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.invalidate(checkinProvider);
    });
  }

  void _showMessage(String text, {required bool ok}) {
    if (!mounted) return;
    setState(() => _message = (text: text, ok: ok));
  }

  Future<void> _saveSettings({bool? auto, String? at}) async {
    if (_savingSettings) return;
    setState(() => _savingSettings = true);
    try {
      await ref.read(checkinProvider.notifier).updateSettings(auto: auto, at: at);
      _showMessage('设置已保存', ok: true);
    } catch (error) {
      _showMessage('设置保存失败：$error', ok: false);
      await ref.read(checkinProvider.notifier).reload();
    } finally {
      if (mounted) setState(() => _savingSettings = false);
    }
  }

  Future<void> _pickTime(String current) async {
    final parts = current.split(':');
    final hour = (int.tryParse(parts.first) ?? 9).clamp(0, 23);
    final minute = (parts.length > 1 ? int.tryParse(parts[1]) ?? 0 : 0).clamp(0, 59);
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: hour, minute: minute),
      helpText: '自动签到时间（北京时间）',
    );
    if (picked == null) return;
    final at =
        '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    await _saveSettings(at: at);
  }

  Future<void> _runOne(CheckinAccountState account) async {
    _showMessage('正在为 ${account.displayName} 签到…', ok: true);
    try {
      final record = await ref.read(checkinProvider.notifier).runOne(
            provider: account.provider,
            accountId: account.accountId,
          );
      final identity =
          account.accountId.isEmpty ? account.displayName : '${account.displayName} · ${account.accountId}';
      _showMessage(
        '$identity：${checkinOutcomeText(record)}'
        '${record.message.isEmpty ? '' : ' · ${record.message}'}',
        ok: record.outcome != 'failed',
      );
    } catch (error) {
      _showMessage('签到失败：$error', ok: false);
    }
  }

  Future<void> _runAll() async {
    _showMessage('正在为所有支持签到的账号执行…', ok: true);
    try {
      final results = await ref.read(checkinProvider.notifier).runAll();
      final claimed = results.where((record) => record.outcome == 'claimed').length;
      final done = results.where((record) => record.outcome == 'done').length;
      final failed = results.where((record) => record.outcome == 'failed').length;
      _showMessage(
        '签到完成：成功 $claimed · 已签到 $done · 失败 $failed'
        '${results.isEmpty ? '（没有可签到的账号）' : ''}',
        ok: failed == 0,
      );
    } catch (error) {
      _showMessage('一键签到失败：$error', ok: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 720;
    final statusAsync = ref.watch(checkinProvider);
    final status = statusAsync.valueOrNull;
    final runtime = ref.watch(runtimeProvider);
    final canRun = runtime.canManageAccounts;

    return Dialog(
      insetPadding: EdgeInsets.symmetric(horizontal: wide ? 40 : 12, vertical: 24),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 760, maxHeight: size.height * 0.86),
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
                        Text('每日签到', style: theme.textTheme.titleLarge),
                        const SizedBox(height: 4),
                        Text(
                          _subtitle(status),
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
            if (!canRun)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '移动端为只读看板：签到会真实请求上游，请在本机客户端或 Web 看板操作。',
                    style: theme.textTheme.labelSmall,
                  ),
                ),
              ),
            Expanded(child: _buildBody(statusAsync, status, canRun)),
          ],
        ),
      ),
    );
  }

  String _subtitle(CheckinStatus? status) {
    if (status == null) return '读取签到状态…';
    final supported = status.accounts.where((account) => account.supported).toList();
    final disabled = supported.where((account) => !account.enabled).length;
    return '共 ${supported.length} 个账号支持签到'
        '${disabled > 0 ? '（$disabled 个已停用）' : ''}；按北京时间每天执行一次';
  }

  Widget _buildBody(AsyncValue<CheckinStatus> asyncValue, CheckinStatus? status, bool canRun) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    if (status == null) {
      if (asyncValue.hasError) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('读取签到状态失败', style: theme.textTheme.titleMedium),
                const SizedBox(height: 6),
                Text('${asyncValue.error}', textAlign: TextAlign.center),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => ref.invalidate(checkinProvider),
                  icon: const Icon(Icons.refresh),
                  label: const Text('重试'),
                ),
              ],
            ),
          ),
        );
      }
      return const Center(child: CircularProgressIndicator());
    }

    final settings = status.settings;
    final accounts = status.accounts.where((account) => account.supported).toList()
      ..sort(
        (a, b) => a.displayName.compareTo(b.displayName) != 0
            ? a.displayName.compareTo(b.displayName)
            : a.accountId.compareTo(b.accountId),
      );
    final disabled = accounts.where((account) => !account.enabled).length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('自动签到', style: theme.textTheme.titleSmall),
                        Text(
                          '到达时间后按北京时间每天执行一次，失败自动重试',
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  Switch(
                    value: settings.auto,
                    onChanged: _savingSettings || !canRun
                        ? null
                        : (value) => _saveSettings(auto: value),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  const SizedBox(width: 2),
                  Icon(Icons.schedule, size: 16, color: scheme.onSurfaceVariant),
                  const SizedBox(width: 6),
                  Text('执行时间', style: theme.textTheme.bodySmall),
                  const Spacer(),
                  OutlinedButton(
                    onPressed: _savingSettings || !canRun
                        ? null
                        : () => _pickTime(settings.at),
                    child: Text('${settings.at}（北京时间）'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            FilledButton.tonalIcon(
              onPressed: !canRun || accounts.isEmpty || ref.watch(checkinAllBusyProvider)
                  ? null
                  : _runAll,
              icon: ref.watch(checkinAllBusyProvider)
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.event_available),
              label: Text(ref.watch(checkinAllBusyProvider) ? '签到中…' : '一键签到全部'),
            ),
            const SizedBox(width: 12),
            if (_message != null)
              Expanded(
                child: Text(
                  _message!.text,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: _message!.ok ? context.tones.success : context.tones.critical,
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Text('账号', style: theme.textTheme.labelMedium),
            const Spacer(),
            if (disabled > 0)
              Text(
                '$disabled 个已停用',
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
          ],
        ),
        const SizedBox(height: 6),
        if (accounts.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 18),
            child: Text(
              '还没有支持每日签到的账号',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          )
        else
          for (final account in accounts) _buildAccountRow(account, status, canRun),
      ],
    );
  }

  Widget _buildAccountRow(CheckinAccountState account, CheckinStatus status, bool canRun) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final tones = context.tones;
    final record = account.record;
    final today = record?.isForToday() ?? false;
    final remoteSigned = account.remote?.signedToday ?? false;
    final tone = today
        ? checkinToneFor(record)
        : (remoteSigned ? CheckinTone.ok : CheckinTone.muted);
    final color = switch (tone) {
      CheckinTone.ok => tones.success,
      CheckinTone.bad => tones.critical,
      CheckinTone.muted => scheme.onSurfaceVariant,
    };
    final key = checkinKeyOf(account.provider, account.accountId);
    final busy = ref.watch(checkinBusyProvider).contains(key) || status.running.contains(key);
    final settled = account.signedToday;

    Widget trailing;
    if (!account.enabled) {
      trailing = Text(
        '账号已停用',
        style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
      );
    } else if (!canRun) {
      trailing = Text(
        '移动端只读',
        style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
      );
    } else {
      trailing = FilledButton.tonal(
        onPressed: busy || settled ? null : () => _runOne(account),
        child: Text(busy ? '签到中…' : settled ? '已签到' : '签到'),
      );
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.25),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(Icons.event_available, size: 18, color: scheme.primary),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  account.displayName.isEmpty ? account.provider : account.displayName,
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  account.accountId.isEmpty ? '默认账号' : account.accountId,
                  style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        account.todayText,
                        style: theme.textTheme.labelSmall?.copyWith(color: color),
                      ),
                    ),
                    if (account.todayAt != null) ...[
                      const SizedBox(width: 8),
                      Text(
                        _timeText(account.todayAt!),
                        style: theme.textTheme.labelSmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ],
                ),
                if (account.todayMessage.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      account.todayMessage,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          trailing,
        ],
      ),
    );
  }

  String _timeText(DateTime time) {
    final local = time.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }
}