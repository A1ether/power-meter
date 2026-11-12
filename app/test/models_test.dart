import 'package:flutter_test/flutter_test.dart';
import 'package:power_meter/core/models/models.dart';

void main() {
  test('DashboardPayload 解析核心字段与可选字段', () {
    final payload = DashboardPayload.fromJson({
      'generatedAt': '2026-11-12T02:00:00.000Z',
      'cacheTtlSeconds': 300,
      'expiryThresholds': {'criticalDays': 3, 'warningDays': 7},
      'totals': {
        'providers': 2,
        'ok': 1,
        'failed': 1,
        'availableByCurrency': {'CREDITS': 1200.5, 'USD': 12},
      },
      'nextExpiry': null,
      'expiryTimeline': [
        {
          'provider': 'demo',
          'displayName': 'Demo',
          'lotId': 'lot-1',
          'lotLabel': '签到积分',
          'amount': 100,
          'currency': 'CREDITS',
          'expiresAt': '2026-11-15T00:00:00.000Z',
          'inDays': 2.9,
          'cny': 0.5,
        }
      ],
      'providers': [
        {
          'provider': 'demo',
          'displayName': 'Demo',
          'status': 'ok',
          'region': 'cn',
          'source': 'api',
          'updatedAt': '2026-11-12T01:59:00.000Z',
          'plan': 'Pro',
          'balance': {'amount': 1200.5, 'currency': 'CREDITS'},
          'credits': [
            {
              'id': 'lot-1',
              'label': '签到积分',
              'amount': 100,
              'currency': 'CREDITS',
              'expiresAt': '2026-11-15T00:00:00.000Z',
              'basis': 'remaining',
              'granted': 200,
            }
          ],
          'windows': [
            {
              'kind': 'daily',
              'label': '每日额度',
              'used': 5,
              'limit': 20,
              'remaining': 15,
              'usedPercent': 25,
              'remainingPercent': 75,
              'boundary': 'reset',
              'resetsAt': '2026-11-13T00:00:00.000Z',
              'showMeter': true,
            }
          ],
          'nextExpiryInDays': 2.9,
          'dailyUsage': {
            'todayUsed': 3,
            'yesterdayUsed': null,
            'todayAdded': 10,
            'yesterdayAdded': 0,
            'currency': 'CREDITS',
            'sources': {
              'todayUsed': 'upstream',
              'yesterdayUsed': 'local',
              'todayAdded': 'upstream',
              'yesterdayAdded': 'mixed',
            },
          },
          'secrets': [
            {'key': 'apiKey', 'label': 'API Key', 'preview': 'sk-abc…9f2c', 'hint': '用于模型调用'}
          ],
        },
        {
          'provider': 'other',
          'displayName': 'Other',
          'status': 'unauthorized',
          'message': '凭证过期',
          'entries': [
            {
              'id': 'acct-1',
              'label': '账号 A',
              'amount': 0,
              'currency': 'POINTS',
              'status': 'ok',
              'secrets': const [],
            }
          ],
        }
      ],
      'warnings': ['示例警告'],
      'missingEnvVars': ['DEMO_COOKIE'],
    });

    expect(payload.expiryThresholds.criticalDays, 3);
    expect(payload.totals.availableByCurrency['CREDITS'], 1200.5);
    expect(payload.expiryTimeline.single.inDays, 2.9);
    expect(payload.providers.length, 2);

    final demo = payload.providers.first;
    expect(demo.healthy, isTrue);
    expect(demo.balanceAmount, 1200.5);
    expect(demo.currency, 'CREDITS');
    expect(demo.credits.single.granted, 200);
    expect(demo.windows.single.showMeter, isTrue);
    expect(demo.dailyUsage!.sources.yesterdayAdded, 'mixed');
    expect(demo.dailyUsage!.todayUsed, 3);
    expect(demo.dailyUsage!.yesterdayUsed, isNull);
    expect(demo.secrets.single.preview, 'sk-abc…9f2c');

    final other = payload.providers.last;
    expect(other.healthy, isFalse);
    expect(other.message, '凭证过期');
    expect(other.entries.single.label, '账号 A');
    expect(other.balanceAmount, 0);

    expect(payload.warnings, ['示例警告']);
    expect(payload.missingEnvVars, ['DEMO_COOKIE']);
  });

  test('ProviderMeta 解析 manageFields 与 loginMethods', () {
    final meta = ProviderMeta.fromJson({
      'id': 'codearts',
      'displayName': 'CodeArts',
      'region': 'cn',
      'manageAccounts': true,
      'manageFields': [
        {
          'key': 'accessKey',
          'label': 'AccessKey',
          'required': true,
          'pairedWith': '',
          'flagGroup': '',
        },
        {
          'key': 'secretKey',
          'label': 'SecretKey',
          'required': true,
          'pairedWith': 'accessKey',
        },
        {
          'key': 'site',
          'label': '站点',
          'target': 'option',
          'choices': ['cn', 'intl'],
          'defaultValue': 'cn',
        }
      ],
      'login': {'label': '扫码登录', 'hint': '用手机扫码', 'qr': true},
      'loginMethods': [
        {'id': 'scan', 'label': '扫码登录', 'hint': '用手机扫码', 'qr': true, 'kind': 'scan'},
        {'id': 'web', 'label': '网页端登录', 'hint': '打开本机 Chrome', 'qr': false, 'kind': 'web'},
      ],
    });

    expect(meta.hasLogin, isTrue);
    expect(meta.loginMethods.length, 2);
    expect(meta.loginMethods.last.kind, 'web');
    expect(meta.manageFields.length, 3);
    expect(meta.manageFields[1].pairedWith, 'accessKey');
    expect(meta.manageFields[2].isSelect, isTrue);
    expect(meta.manageFields[2].isOption, isTrue);
    expect(meta.manageFields[2].defaultValue, 'cn');
  });

  test('未知状态与缺失字段不抛错', () {
    final provider = ProviderSnapshot.fromJson({
      'provider': 'x',
      'displayName': 'X',
      'status': 'brandNewStatus',
      'credits': [
        {'id': 'a', 'label': 'A', 'amount': 1, 'currency': 'UNKNOWN', 'basis': 'weird'},
      ],
    });
    expect(provider.status, 'brandNewStatus');
    expect(provider.healthy, isFalse);
    expect(provider.credits.single.currency, 'UNKNOWN');
    expect(provider.dailyUsage, isNull);
    expect(provider.balanceAmount, 1);
  });
}
