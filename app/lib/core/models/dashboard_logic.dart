import '../format/formatters.dart';
import '../models/models.dart';

/// 看板的派生状态：紧迫度、平台分组、排序 / 筛选、诊断计数。
///
/// 全部是纯函数，便于单测；口径逐条对应 `public/app.js:229-538`，
/// 保证 Flutter 端与旧看板对同一份 `/api/summary` 给出一致结果。

ExpiryLevel urgencyOf(ProviderSnapshot provider, ExpiryThresholds thresholds, {DateTime? now}) {
  final levels = provider.credits
      .where((lot) => lot.amount > 0)
      .map((lot) => levelFor(
            daysUntil(lot.expiresAt, now: now),
            criticalDays: thresholds.criticalDays,
            warningDays: thresholds.warningDays,
          ));
  if (levels.contains(ExpiryLevel.critical)) return ExpiryLevel.critical;
  if (levels.contains(ExpiryLevel.warning)) return ExpiryLevel.warning;
  return ExpiryLevel.safe;
}

ExpiryLevel groupUrgency(List<ProviderSnapshot> members, ExpiryThresholds thresholds) {
  final levels = members.map((item) => urgencyOf(item, thresholds));
  if (levels.contains(ExpiryLevel.critical)) return ExpiryLevel.critical;
  if (levels.contains(ExpiryLevel.warning)) return ExpiryLevel.warning;
  return ExpiryLevel.safe;
}

/// 组金额：组内可用快照、同币种才求和；混币种返回 null（界面显示 —）。
double? groupBalance(List<ProviderSnapshot> members) {
  final healthy = members.where((item) => item.healthy).toList();
  if (healthy.isEmpty) return null;
  final currencies = healthy.map((item) => item.currency).toSet();
  if (currencies.length > 1) return null;
  return healthy.fold<double>(0, (sum, item) => sum + item.balanceAmount);
}

class PlatformGroup {
  const PlatformGroup({required this.provider, required this.label, required this.members});

  final String provider;
  final String label;
  final List<ProviderSnapshot> members;
}

String baseNameOf(String providerId, List<ProviderSnapshot> members, Map<String, ProviderMeta> meta) {
  final displayName = meta[providerId]?.displayName;
  if (displayName != null && displayName.isNotEmpty) return displayName;
  final first = members.isNotEmpty ? members.first.displayName : providerId;
  final head = first.split(' · ').first.trim();
  return head.isEmpty ? providerId : head;
}

List<PlatformGroup> platformGroups(
  List<ProviderSnapshot> providers,
  Map<String, ProviderMeta> meta,
) {
  final buckets = <String, List<ProviderSnapshot>>{};
  for (final provider in providers) {
    buckets.putIfAbsent(provider.provider, () => []).add(provider);
  }
  return buckets.entries
      .map((entry) => PlatformGroup(
            provider: entry.key,
            label: baseNameOf(entry.key, entry.value, meta),
            members: entry.value,
          ))
      .toList();
}

enum SortMode { expiry, risk, amountAsc, amountDesc, status, name }

extension SortModeLabel on SortMode {
  String get label => switch (this) {
        SortMode.expiry => '最快到期优先',
        SortMode.risk => '仅看有到期风险的',
        SortMode.amountAsc => '余额从少到多',
        SortMode.amountDesc => '余额从多到少',
        SortMode.status => '异常优先',
        SortMode.name => '按名称',
      };
}

List<ProviderSnapshot> sortedProviders(
  List<ProviderSnapshot> providers, {
  required SortMode sort,
  required String query,
  required ExpiryThresholds thresholds,
  DateTime? now,
}) {
  var result = providers;
  final keyword = query.trim().toLowerCase();
  if (keyword.isNotEmpty) {
    result = result.where((provider) {
      final haystack = <String>[
        provider.displayName,
        provider.provider,
        provider.plan ?? '',
        provider.currency,
        ...provider.credits.map((lot) => lot.label),
      ].join(' ').toLowerCase();
      return haystack.contains(keyword);
    }).toList();
  }

  if (sort == SortMode.risk) {
    result = result.where((provider) => urgencyOf(provider, thresholds, now: now) != ExpiryLevel.safe).toList();
  }

  final ranked = [...result];
  int rank(ExpiryLevel level) => switch (level) {
        ExpiryLevel.critical => 0,
        ExpiryLevel.warning => 1,
        ExpiryLevel.safe || ExpiryLevel.none => 2,
      };

  ranked.sort((a, b) {
    switch (sort) {
      case SortMode.amountAsc:
        return a.balanceAmount.compareTo(b.balanceAmount);
      case SortMode.amountDesc:
        return b.balanceAmount.compareTo(a.balanceAmount);
      case SortMode.name:
        return a.displayName.compareTo(b.displayName);
      case SortMode.status:
        return (a.healthy ? 1 : 0).compareTo(b.healthy ? 1 : 0);
      case SortMode.risk:
      case SortMode.expiry:
        final levelDiff =
            rank(urgencyOf(a, thresholds, now: now)) - rank(urgencyOf(b, thresholds, now: now));
        if (levelDiff != 0) return levelDiff;
        final aDays = a.nextExpiryInDays ?? double.infinity;
        final bDays = b.nextExpiryInDays ?? double.infinity;
        if (aDays != bDays) return aDays.compareTo(bDays);
        return a.displayName.compareTo(b.displayName);
    }
  });
  return ranked;
}

/// 需要处理的诊断条数：缺环境变量 + 聚合警告 + 状态非 ok/demo/notConfigured。
int countDiagnostics(DashboardPayload payload) {
  final unhealthy = payload.providers
      .where((provider) =>
          provider.status != 'ok' &&
          provider.status != 'demo' &&
          provider.status != 'notConfigured')
      .length;
  return payload.missingEnvVars.length + payload.warnings.length + unhealthy;
}

/// 批次按到期时间升序；无过期时间的排在最后。
List<CreditLot> sortedLots(List<CreditLot> lots, {DateTime? now}) {
  final sorted = [...lots];
  sorted.sort((a, b) {
    final aDays = daysUntil(a.expiresAt, now: now) ?? double.infinity;
    final bDays = daysUntil(b.expiresAt, now: now) ?? double.infinity;
    return aDays.compareTo(bDays);
  });
  return sorted;
}

int criticalHits(DashboardPayload payload) =>
    payload.expiryTimeline.where((hit) => hit.inDays <= payload.expiryThresholds.criticalDays).length;

int warningHits(DashboardPayload payload) => payload.expiryTimeline
    .where((hit) =>
        hit.inDays > payload.expiryThresholds.criticalDays &&
        hit.inDays <= payload.expiryThresholds.warningDays)
    .length;

/* ------------------------------------------------------------------ *
 * 「最先到期」首屏：时刻换算、按天分组、2/5 天窗口
 * 口径对应 `public/app.js:2823-2984`。
 * ------------------------------------------------------------------ */

/// 收起时只看未来 2 天，展开上限 5 天（与 Web 的 EXPIRY_DEFAULT_DAYS / EXPIRY_MAX_DAYS 一致）。
const int expiryWindowDays = 2;
const int expiryMaxDays = 5;

String _twoDigits(int value) => value.toString().padLeft(2, '0');

/// 本地时区下的「哪天 + 几点」，用于分组标题与行内时刻。
class ExpiryMoment {
  const ExpiryMoment({required this.label, required this.clock, required this.dayKey});

  /// 已过期 / 今天 / 明天 / 后天 / MM/DD。
  final String label;

  /// HH:mm。
  final String clock;

  /// `Y-M-D`，只用于把同一本地日期的批次切成一组。
  final String dayKey;
}

ExpiryMoment expiryMomentOf(DateTime expiresAt, {DateTime? now}) {
  final at = expiresAt.toLocal();
  final current = (now ?? DateTime.now()).toLocal();
  DateTime startOf(DateTime value) => DateTime(value.year, value.month, value.day);
  final diffDays =
      (startOf(at).difference(startOf(current)).inMilliseconds / 86400000).round();
  final clock = '${_twoDigits(at.hour)}:${_twoDigits(at.minute)}';
  final dayKey = '${at.year}-${at.month}-${at.day}';

  if (diffDays < 0) return ExpiryMoment(label: '已过期', clock: clock, dayKey: dayKey);
  if (diffDays == 0) return ExpiryMoment(label: '今天', clock: clock, dayKey: dayKey);
  if (diffDays == 1) return ExpiryMoment(label: '明天', clock: clock, dayKey: dayKey);
  if (diffDays == 2) return ExpiryMoment(label: '后天', clock: clock, dayKey: dayKey);
  return ExpiryMoment(
    label: '${_twoDigits(at.month)}/${_twoDigits(at.day)}',
    clock: clock,
    dayKey: dayKey,
  );
}

/// 到期批次按本地时刻升序；同一时刻保持原顺序。
List<ExpiryHit> sortedExpiryHits(List<ExpiryHit> hits) {
  final sorted = [...hits];
  sorted.sort((a, b) => a.expiresAt.compareTo(b.expiresAt));
  return sorted;
}

class ExpiryDayGroup {
  const ExpiryDayGroup({required this.label, required this.dayKey, required this.hits});

  final String label;
  final String dayKey;
  final List<ExpiryHit> hits;
}

/// 先按本地时刻升序，再按本地日期连续切组（不重排、不跳组）。
List<ExpiryDayGroup> groupExpiryHits(List<ExpiryHit> hits, {DateTime? now}) {
  final groups = <ExpiryDayGroup>[];
  for (final hit in sortedExpiryHits(hits)) {
    final moment = expiryMomentOf(hit.expiresAt, now: now);
    final last = groups.isEmpty ? null : groups.last;
    if (last != null && last.dayKey == moment.dayKey) {
      last.hits.add(hit);
    } else {
      groups.add(ExpiryDayGroup(label: moment.label, dayKey: moment.dayKey, hits: [hit]));
    }
  }
  return groups;
}
