import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/format/formatters.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import '../../state/providers.dart';

/// 账号管理区：登录（扫码 / 链接 / 网页端）、手工凭证、已配置账号清单。
///
/// 全部按 `/api/providers` 的声明渲染，不认平台名——与旧前端
/// `public/app.js:1450-1805` 的行为一致。
class ManagePanel extends ConsumerStatefulWidget {
  const ManagePanel({
    super.key,
    required this.providerId,
    required this.meta,
    this.targetAccountId,
    this.onChanged,
  });

  final String providerId;
  final ProviderMeta? meta;
  final String? targetAccountId;
  final Future<void> Function()? onChanged;

  @override
  ConsumerState<ManagePanel> createState() => _ManagePanelState();
}

class _ManagePanelState extends ConsumerState<ManagePanel> {
  final _nameController = TextEditingController();
  final Map<String, TextEditingController> _controllers = {};

  AccountsList? _accounts;
  bool _loadingAccounts = false;
  String? _accountsError;

  LoginSessionView? _session;
  String? _startingMethod;
  Timer? _pollTimer;
  bool _polling = false;

  bool _submitting = false;
  bool _manualOpen = false;
  ({bool ok, String text})? _message;

  ProviderMeta? get meta => widget.meta;
  bool get _canLogin => meta?.hasLogin ?? false;

  @override
  void initState() {
    super.initState();
    _ensureControllers();
    _loadAccounts();
  }

  @override
  void didUpdateWidget(covariant ManagePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.meta != widget.meta) _ensureControllers();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _nameController.dispose();
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _ensureControllers() {
    final fields = meta?.manageFields ?? const <ManageField>[];
    for (final field in fields) {
      _controllers.putIfAbsent(
        field.key,
        () => TextEditingController(text: field.defaultValue ?? ''),
      );
    }
  }

  Future<void> _loadAccounts() async {
    if (!mounted) return;
    setState(() {
      _loadingAccounts = true;
      _accountsError = null;
    });
    try {
      final list = await ref.read(apiProvider).accounts(widget.providerId);
      if (!mounted) return;
      setState(() => _accounts = list);
    } catch (error) {
      if (!mounted) return;
      setState(() => _accountsError = '$error');
    } finally {
      if (mounted) setState(() => _loadingAccounts = false);
    }
  }

  /* ----------------------------- 登录 ----------------------------- */

  Future<void> _startLogin(LoginMethod method) async {
    if (_startingMethod != null) return;
    setState(() {
      _startingMethod = method.id;
      _message = null;
    });
    try {
      if (_session != null) {
        try {
          await ref.read(apiProvider).cancelLogin(_session!.id);
        } catch (_) {
          // 旧会话过期 / 已清理时忽略
        }
        _pollTimer?.cancel();
        _pollTimer = null;
      }
      final view = await ref.read(apiProvider).startLogin(
            provider: widget.providerId,
            method: method.id,
            targetAccountId: widget.targetAccountId,
          );
      if (!mounted) return;
      setState(() => _session = view);
      _schedulePoll();
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = (ok: false, text: '发起登录失败：$error'));
    } finally {
      if (mounted) setState(() => _startingMethod = null);
    }
  }

  void _schedulePoll() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(milliseconds: 1500), (_) async {
      if (_polling) return;
      final current = _session;
      if (current == null || current.terminal) {
        _pollTimer?.cancel();
        _pollTimer = null;
        return;
      }
      _polling = true;
      try {
        final view = await ref.read(apiProvider).pollLogin(current.id);
        if (!mounted) return;
        setState(() => _session = view);
        if (view.terminal) {
          _pollTimer?.cancel();
          _pollTimer = null;
          if (view.status == 'ready') {
            final account = view.account;
            setState(() => _message = (
              ok: true,
              text: account == null
                  ? '登录成功，凭证已写入本机。'
                  : account.updated
                      ? '已更新「${account.name}」的登录凭证'
                      : '已添加「${account.name}」',
            ));
            await _loadAccounts();
            await widget.onChanged?.call();
          }
        }
      } catch (error) {
        if (!mounted) return;
        _pollTimer?.cancel();
        _pollTimer = null;
        setState(() {
          _session = current.copyWith(
            status: 'invalid',
            authUrl: null,
            message: '登录会话已失效：$error',
          );
        });
      } finally {
        _polling = false;
      }
    });
  }

  Future<void> _cancelLogin() async {
    final session = _session;
    if (session == null) return;
    try {
      final view = await ref.read(apiProvider).cancelLogin(session.id);
      if (!mounted) return;
      setState(() => _session = view);
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = (ok: false, text: '取消失败：$error'));
    }
  }

  Future<void> _copyAuthUrl(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!mounted) return;
    setState(() => _message = (ok: true, text: '登录链接已复制'));
  }

  Future<void> _openAuthUrl(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  /* ----------------------------- 表单 ----------------------------- */

  bool _requiredNow(ManageField field, Set<String> filled) {
    if (field.pairedWith.isEmpty && field.flagGroup.isEmpty) return field.required;
    final group = field.flagGroup.isNotEmpty
        ? (meta?.manageFields ?? const []).where((item) => item.flagGroup == field.flagGroup).toList()
        : [field, ...(meta?.manageFields ?? const []).where((item) => item.key == field.pairedWith)];
    if (group.isEmpty) return field.required;
    final anchor = group.first.pairedWith.isEmpty ? group.first : null;
    if (anchor == field) return true;
    return group.any((item) => filled.contains(item.key));
  }

  Future<void> _submit() async {
    final fields = meta?.manageFields ?? const <ManageField>[];
    if (fields.isEmpty) return;

    final filled = <String>{
      for (final field in fields)
        if ((_controllers[field.key]?.text ?? '').trim().isNotEmpty) field.key,
    };
    final missing = <String>[];
    for (final field in fields) {
      if (_requiredNow(field, filled) && !filled.contains(field.key)) missing.add(field.label);
    }
    if (missing.isNotEmpty) {
      setState(() => _message = (ok: false, text: '请填写：${missing.join('、')}。'));
      return;
    }

    final credentials = <String, String>{};
    final options = <String, String>{};
    for (final field in fields) {
      final value = (_controllers[field.key]?.text ?? '').trim();
      if (value.isEmpty) continue;
      if (field.isOption) {
        options[field.key] = value;
      } else {
        credentials[field.key] = value;
      }
    }

    setState(() {
      _submitting = true;
      _message = null;
    });
    try {
      final result = await ref.read(apiProvider).addAccount(
            provider: widget.providerId,
            credentials: credentials,
            options: options,
            name: _nameController.text,
          );
      final account = (result['account'] as Map?)?.cast<String, dynamic>() ?? const {};
      final label = '${account['label'] ?? result['name'] ?? '账号'}';
      final amount = account['amount'];
      final currency = '${account['currency'] ?? ''}';
      final details = (result['details'] as List? ?? const []).map((item) => '$item').join(' · ');
      final optionText = (result['options'] as Map? ?? const {})
          .entries
          .map((entry) => '${entry.key}=${entry.value}')
          .join(' · ');
      final envText = (result['envRefs'] as List? ?? const []).map((item) => '$item').join(' / ');
      if (!mounted) return;
      setState(() => _message = (
            ok: true,
            text: '已添加「$label」：${fmtNumber(amount is num ? amount : null)} $currency'
                '${details.isEmpty ? '' : ' · $details'}'
                '${optionText.isEmpty ? '' : ' · $optionText'}'
                '${envText.isEmpty ? '' : ' · 凭证变量 $envText'}',
          ));
      _nameController.clear();
      for (final field in fields) {
        _controllers[field.key]?.text = field.defaultValue ?? '';
      }
      await _loadAccounts();
      await widget.onChanged?.call();
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = (ok: false, text: '添加失败：$error'));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _remove(ManagedAccount account) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除账号'),
        content: Text('确定删除「${account.label}」吗？改动前会自动备份到 .run/。'),
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
    try {
      await ref.read(apiProvider).removeAccount(provider: widget.providerId, accountId: account.id);
      if (!mounted) return;
      setState(() => _message = (ok: true, text: '已删除「${account.label}」'));
      await _loadAccounts();
      await widget.onChanged?.call();
    } catch (error) {
      if (!mounted) return;
      setState(() => _message = (ok: false, text: '删除失败：$error'));
    }
  }

  /* ----------------------------- 渲染 ----------------------------- */

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final fields = meta?.manageFields ?? const <ManageField>[];

    if (meta == null) {
      return _Notice(
        text: '读取平台能力清单失败，暂时无法在这里管理账号；请刷新页面后重试。',
        warn: true,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_canLogin) ...[
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final method in meta!.loginMethods)
                _buildMethodButton(method),
            ],
          ),
          if (meta!.login?.hint.isNotEmpty ?? false)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                meta!.login!.hint,
                style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
          if (_session != null) ...[
            const SizedBox(height: 10),
            _buildLoginPanel(theme),
          ],
        ],
        if (fields.isNotEmpty) ...[
          const SizedBox(height: 10),
          _buildManualForm(theme),
        ] else if (!_canLogin)
          _Notice(text: '该平台暂未声明可添加的字段或登录方式。', warn: true),
        if (meta!.manageHint.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              meta!.manageHint,
              style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
        if (_message != null) ...[
          const SizedBox(height: 10),
          _Notice(text: _message!.text, warn: !_message!.ok),
        ],
        const SizedBox(height: 12),
        _buildAccountsList(theme),
      ],
    );
  }

  Widget _buildMethodButton(LoginMethod method) {
    final active = _session != null && _session!.method == method.id;
    final busy = _startingMethod == method.id || (active && !_session!.terminal);
    final label = active
        ? (_session!.terminal ? '重新获取' : '登录中…')
        : busy
            ? '申请中…'
            : method.label;
    final onPressed = busy ? null : () => _startLogin(method);
    return method.kind == 'web'
        ? OutlinedButton.icon(
            onPressed: onPressed,
            icon: const Icon(Icons.language, size: 18),
            label: Text(label),
          )
        : FilledButton.icon(
            onPressed: onPressed,
            icon: Icon(method.qr ? Icons.qr_code_2 : Icons.open_in_new, size: 18),
            label: Text(label),
          );
  }

  Widget _buildLoginPanel(ThemeData theme) {
    final session = _session!;
    final authUrl = session.authUrl;
    var isWebKind = false;
    for (final method in meta!.loginMethods) {
      if (method.id == session.method) {
        isWebKind = method.kind == 'web';
        break;
      }
    }
    final statusText = session.message ?? loginStatusText[session.status] ?? session.status;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(statusText, style: theme.textTheme.bodyMedium),
          if (authUrl != null && !isWebKind) ...[
            const SizedBox(height: 10),
            if (session.qr)
              Center(
                child: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
                  child: QrImageView(data: authUrl, size: 190),
                ),
              ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => _openAuthUrl(authUrl),
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('在新窗口打开登录页'),
                ),
                OutlinedButton.icon(
                  onPressed: () => _copyAuthUrl(authUrl),
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('复制链接'),
                ),
              ],
            ),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: session.terminal
                ? null
                : TextButton(onPressed: _cancelLogin, child: const Text('取消登录')),
          ),
          if (session.status == 'ready' && session.account != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                session.account!.updated
                    ? '已更新「${session.account!.name}」的登录凭证'
                    : '已添加「${session.account!.name}」',
                style: theme.textTheme.labelMedium?.copyWith(color: context.tones.success),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildManualForm(ThemeData theme) {
    final fields = meta!.manageFields;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6)),
        borderRadius: BorderRadius.circular(12),
      ),
      child: ExpansionTile(
        initiallyExpanded: _manualOpen || !_canLogin,
        onExpansionChanged: (value) => setState(() => _manualOpen = value),
        tilePadding: const EdgeInsets.symmetric(horizontal: 12),
        childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        title: Text(
          _canLogin ? '手工填写凭证（兜底）' : '填写凭证',
          style: theme.textTheme.labelLarge,
        ),
        children: [
          for (final field in fields) ...[
            _buildField(field, theme),
            const SizedBox(height: 10),
          ],
          TextField(
            controller: _nameController,
            decoration: const InputDecoration(
              labelText: '账号备注名（可选）',
              hintText: '留空自动命名，如「CodeBuddy · 账号 2」',
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.verified_user_outlined, size: 18),
              label: Text(_submitting ? '验证中…' : '验证并添加'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildField(ManageField field, ThemeData theme) {
    final controller = _controllers[field.key]!;
    final label = '${field.label}${field.required ? '（必填）' : '（可选）'}';
    if (field.isSelect) {
      final initial = field.choices.contains(field.defaultValue)
          ? field.defaultValue!
          : field.choices.first;
      return DropdownButtonFormField<String>(
        initialValue: initial,
        decoration: InputDecoration(labelText: label, hintText: field.placeholder),
        items: [
          for (final choice in field.choices)
            DropdownMenuItem(value: choice, child: Text(choice)),
        ],
        onChanged: (value) => controller.text = value ?? '',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: controller,
          obscureText: field.secret && !field.multiline,
          maxLines: field.multiline ? 3 : 1,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(
            labelText: label,
            hintText: field.placeholder,
          ),
        ),
        if (field.hint.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4, left: 4),
            child: Text(
              field.hint,
              style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ),
      ],
    );
  }

  Widget _buildAccountsList(ThemeData theme) {
    final accounts = _accounts?.accounts ?? const <ManagedAccount>[];
    final warnings = _accounts?.warnings ?? const <String>[];
    if (_loadingAccounts && _accounts == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: LinearProgressIndicator(minHeight: 2),
      );
    }
    if (_accountsError != null) {
      return _Notice(text: '读取账号清单失败：$_accountsError', warn: true);
    }
    if (accounts.isEmpty && warnings.isEmpty) {
      return Text(
        '该平台还没有配置账号。',
        style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text('已配置账号（${accounts.length}）', style: theme.textTheme.labelMedium),
            const Spacer(),
            if (_loadingAccounts)
              const SizedBox.square(dimension: 12, child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ),
        const SizedBox(height: 6),
        for (final account in accounts) _AccountRow(account: account, onRemove: () => _remove(account)),
        for (final warning in warnings)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              warning,
              style: theme.textTheme.labelSmall?.copyWith(color: context.tones.warning),
            ),
          ),
      ],
    );
  }
}

class _AccountRow extends StatelessWidget {
  const _AccountRow({required this.account, required this.onRemove});

  final ManagedAccount account;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final previews = account.previews.entries.toList();
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.28),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(child: Text(account.label, style: theme.textTheme.bodySmall)),
                    if (!account.enabled) ...[
                      const SizedBox(width: 6),
                      _MiniTag(text: '已停用', color: scheme.onSurfaceVariant),
                    ],
                    if (account.complete) ...[
                      const SizedBox(width: 6),
                      _MiniTag(text: '凭证完整', color: context.tones.success),
                    ] else ...[
                      const SizedBox(width: 6),
                      _MiniTag(text: '缺凭证', color: scheme.error),
                    ],
                  ],
                ),
                if (account.id.isNotEmpty && account.id != account.label)
                  Text(account.id,
                      style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
                if (previews.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Wrap(
                      spacing: 10,
                      children: [
                        for (final entry in previews)
                          Text(
                            '${entry.key}: ${entry.value}',
                            style: theme.textTheme.labelSmall?.copyWith(
                              fontFamily: 'monospace',
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
                if (account.options.isNotEmpty)
                  Text(
                    account.options.entries.map((entry) => '${entry.key}=${entry.value}').join(' · '),
                    style: theme.textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
              ],
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: '删除账号',
            onPressed: onRemove,
            icon: Icon(Icons.delete_outline, size: 18, color: scheme.error),
          ),
        ],
      ),
    );
  }
}

class _MiniTag extends StatelessWidget {
  const _MiniTag({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color));
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.warn});

  final String text;
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: warn
            ? context.tones.warningContainer.withValues(alpha: 0.5)
            : context.tones.successContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            warn ? Icons.warning_amber_rounded : Icons.check_circle_outline,
            size: 18,
            color: warn ? context.tones.warning : context.tones.success,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }
}
