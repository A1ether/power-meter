import 'package:flutter_test/flutter_test.dart';
import 'package:power_meter/core/format/formatters.dart';
import 'package:power_meter/core/models/dashboard_logic.dart';
import 'package:power_meter/core/models/models.dart';

ProviderSnapshot _provider({
  required String id,
  String status = 'ok',
  double amount = 100,
  String currency = 'CREDITS',
  List<Map<String, dynamic>> credits = const [],
  double? nextInDays,
  String displayName = '',
}) {
  return ProviderSnapshot.fromJson({
    'provider': id,
    'displayName': displayName.isEmpty ? id : displayName,
    'status': status,
    'accountId': '',
    'balance': {'amount': amount, 'currency': currency},
    'credits': credits,
    'nextExpiryInDays': nextInDays,
  });
}

Map<String, dynamic> _lot(String id, double amount, DateTime? expiresAt) => {
      'id': id,
      'label': id,
      'amount': amount,
      'currency': 'CREDITS',
      'expiresAt': expiresAt?.toUtc().toIso8601String(),
      'basis': 'remaining',
    };

void main() {
  final now = DateTime.utc(2026, 11, 12, 12);
  const thresholds = ExpiryThresholds(criticalDays: 3, warningDays: 7);

  test('紧迫度按批次最早到期分级', () {
    final critical = _provider(
      id: 'a',
      credits: [_lot('c1', 10, now.add(const Duration(days: 2)))],
    );
    final warning = _provider(
      id: 'b',
      credits: [_lot('c2', 10, now.add(const Duration(days: 5)))],
    );
    final safe = _provider(
      id: 'c',
      credits: [_lot('c3', 10, now.add(const Duration(days: 20)))],
    );
    final noExpiry = _provider(id: 'd', credits: [_lot('c4', 10, null)]);

    expect(urgencyOf(critical, thresholds, now: now), ExpiryLevel.critical);
    expect(urgencyOf(warning, thresholds, now: now), ExpiryLevel.warning);
    expect(urgencyOf(safe, thresholds, now: now), ExpiryLevel.safe);
    expect(urgencyOf(noExpiry, thresholds, now: now), ExpiryLevel.safe);
  });

  test('最快到期排序：分级优先，同组按天数升序', () {
    final providers = [
      _provider(id: 'safe', nextInDays: 30, credits: [_lot('s', 1, now.add(const Duration(days: 30)))]),
      _provider(id: 'warnB', nextInDays: 6, credits: [_lot('w', 1, now.add(const Duration(days: 6)))]),
      _provider(id: 'crit', nextInDays: 1, credits: [_lot('c', 1, now.add(const Duration(days: 1)))]),
      _provider(id: 'warnA', nextInDays: 4, credits: [_lot('w', 1, now.add(const Duration(days: 4)))]),
    ];

    final sorted = sortedProviders(
      providers,
      sort: SortMode.expiry,
      query: '',
      thresholds: thresholds,
      now: now,
    );

    expect(sorted.map((item) => item.provider), ['crit', 'warnA', 'warnB', 'safe']);
  });

  test('风险筛选只保留 critical / warning', () {
    final providers = [
      _provider(id: 'safe', credits: [_lot('s', 1, now.add(const Duration(days: 30)))]),
      _provider(id: 'warn', credits: [_lot('w', 1, now.add(const Duration(days: 5)))]),
    ];
    final sorted = sortedProviders(
      providers,
      sort: SortMode.risk,
      query: '',
      thresholds: thresholds,
      now: now,
    );
    expect(sorted.map((item) => item.provider), ['warn']);
  });

  test('搜索覆盖平台名、套餐、币种与批次标签', () {
    final providers = [
      _provider(id: 'a', displayName: 'CodeBuddy', currency: 'POINTS', credits: [_lot('签到积分', 1, null)]),
      _provider(id: 'b', displayName: 'Trae'),
    ];
    List<String> search(String query) => sortedProviders(
          providers,
          sort: SortMode.expiry,
          query: query,
          thresholds: thresholds,
          now: now,
        ).map((item) => item.provider).toList();

    expect(search('code'), ['a']);
    expect(search('签到'), ['a']);
    expect(search('POINTS'), ['a']);
    expect(search('zzz'), isEmpty);
  });

  test('组金额同币种求和，混币种返回 null', () {
    final same = [
      _provider(id: 'a', amount: 10),
      _provider(id: 'a', amount: 15),
    ];
    final mixed = [
      _provider(id: 'a', amount: 10, currency: 'CREDITS'),
      _provider(id: 'a', amount: 15, currency: 'POINTS'),
    ];
    expect(groupBalance(same), 25);
    expect(groupBalance(mixed), isNull);
  });

  test('同平台多账号合并为一行，标签取注册表显示名', () {
    final providers = [_provider(id: 'a1', displayName: '平台 · 账号 1'), _provider(id: 'a1', displayName: '平台 · 账号 2')];
    final meta = { 'a1': ProviderMeta.fromJson({'id': 'a1', 'displayName': '平台'}) };
    final groups = platformGroups(providers, meta);
    expect(groups.length, 1);
    expect(groups.single.label, '平台');
    expect(groups.single.members.length, 2);
  });

  test('诊断计数排除 notConfigured', () {
    final payload = DashboardPayload.fromJson({
      'providers': [
        {'provider': 'a', 'displayName': 'A', 'status': 'ok'},
        {'provider': 'b', 'displayName': 'B', 'status': 'notConfigured'},
        {'provider': 'c', 'displayName': 'C', 'status': 'error'},
      ],
      'warnings': ['w1'],
      'missingEnvVars': ['V1'],
    });
    expect(countDiagnostics(payload), 3);
  });

  test('格式化口径与旧看板一致', () {
    expect(fmtNumber(1234.567), '1,234.57');
    expect(fmtNumber(null), '–');
    expect(fmtCny(0.5), '¥0.50');
    expect(fmtCny(null), '');
    expect(expiryText(null), '无过期时间');
    expect(expiryText(-2.2), '已过期 2 天');
    expect(expiryText(0.02), '不足 1 小时');
    expect(expiryText(2.6), '3 天后到期');
    expect(levelFor(3, criticalDays: 3, warningDays: 7), ExpiryLevel.critical);
    expect(levelFor(3.1, criticalDays: 3, warningDays: 7), ExpiryLevel.warning);
    expect(levelFor(-1, criticalDays: 3, warningDays: 7), ExpiryLevel.none);
    expect(levelFor(null, criticalDays: 3, warningDays: 7), ExpiryLevel.none);
  });

  test('批次排序把无过期时间的放最后', () {
    final lots = [
      CreditLot.fromJson(_lot('none', 1, null)),
      CreditLot.fromJson(_lot('late', 1, now.add(const Duration(days: 10)))),
      CreditLot.fromJson(_lot('soon', 1, now.add(const Duration(days: 1)))),
    ];
    expect(sortedLots(lots, now: now).map((lot) => lot.id), ['soon', 'late', 'none']);
  });
}
