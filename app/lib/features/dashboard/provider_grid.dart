import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/models.dart';
import '../../state/providers.dart';
import '../accounts/platforms_dialog.dart';
import 'provider_card.dart';

class ProviderGrid extends ConsumerWidget {
  const ProviderGrid({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final providers = ref.watch(visibleProvidersProvider);
    final payload = ref.watch(dashboardProvider).valueOrNull;
    final query = ref.watch(searchQueryProvider).trim();
    final canManage = ref.watch(runtimeProvider).canManageAccounts;

    if (providers.isEmpty) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
          child: Column(
            children: [
              Icon(
                query.isEmpty ? Icons.inbox_outlined : Icons.search_off,
                size: 40,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: 12),
              Text(
                query.isEmpty ? '还没有启用的平台' : '没有匹配的平台',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (query.isEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  '登录或填写凭证，完成后这里会自动出现卡片。',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 16),
                if (canManage)
                  FilledButton.icon(
                    onPressed: () => showPlatformsDialog(context, ref),
                    icon: const Icon(Icons.add),
                    label: const Text('添加平台账号'),
                  ),
              ],
            ],
          ),
        ),
      );
    }

    final thresholds = payload?.expiryThresholds ?? const ExpiryThresholds();
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 1180
            ? 3
            : constraints.maxWidth >= 720
                ? 2
                : 1;
        const spacing = 16.0;
        final width = (constraints.maxWidth - spacing * (columns - 1)) / columns;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final provider in providers)
              SizedBox(
                width: width,
                child: ProviderCard(provider: provider, thresholds: thresholds),
              ),
          ],
        );
      },
    );
  }
}
