import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/models.dart';
import '../../state/providers.dart';

/// 托管密钥：只显示掩码预览；明文仅在用户点击时按需读取，且不落任何本地状态。
class SecretTile extends ConsumerStatefulWidget {
  const SecretTile({
    super.key,
    required this.provider,
    required this.accountId,
    required this.secret,
    this.enabled = true,
  });

  final String provider;
  final String accountId;
  final SecretRef secret;
  final bool enabled;

  @override
  ConsumerState<SecretTile> createState() => _SecretTileState();
}

class _SecretTileState extends ConsumerState<SecretTile> {
  bool _busy = false;

  Future<String?> _reveal() async {
    setState(() => _busy = true);
    try {
      return await ref.read(apiProvider).revealSecret(
            provider: widget.provider,
            accountId: widget.accountId,
            key: widget.secret.key,
          );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('读取失败：$error')));
      }
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _copy() async {
    final value = await _reveal();
    if (value == null) return;
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('已复制 ${widget.secret.label}')),
    );
  }

  Future<void> _show() async {
    final value = await _reveal();
    if (value == null || !mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(widget.secret.label),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.secret.hint.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(widget.secret.hint, style: Theme.of(context).textTheme.bodySmall),
              ),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(10),
              ),
              child: SelectableText(
                value,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '关闭对话框后明文即从界面释放；不会写入日志或本地存储。',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: value));
              if (context.mounted) Navigator.of(context).pop();
            },
            child: const Text('复制并关闭'),
          ),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('关闭')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(widget.secret.label, style: theme.textTheme.labelMedium),
                const SizedBox(height: 2),
                Text(
                  widget.secret.preview,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (widget.enabled) ...[
            TextButton(
              onPressed: _busy ? null : _show,
              child: const Text('显示'),
            ),
            IconButton(
              tooltip: '复制',
              onPressed: _busy ? null : _copy,
              icon: _busy
                  ? const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.copy, size: 18),
            ),
          ] else
            Tooltip(
              message: '移动端不读取密钥明文',
              child: Icon(Icons.lock_outline, size: 18, color: scheme.onSurfaceVariant),
            ),
        ],
      ),
    );
  }
}
