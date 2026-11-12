/// 与 `src/types.ts` / `src/providers/index.ts` 一一对应的数据契约。
///
/// 约定：
/// - 字段名保持后端 camelCase，手写 [fromJson]，不引入代码生成；
/// - 数字统一 `double`，展示层再决定小数位；
/// - 未知枚举值不抛错，保留原始字符串，避免上游新增状态导致整页失败。
library;

double? _num(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

int? _int(Object? value) {
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

String _str(Object? value, [String fallback = '']) =>
    value is String ? value : (value == null ? fallback : '$value');

String? _strOrNull(Object? value) => value is String && value.isNotEmpty ? value : null;

bool _bool(Object? value, [bool fallback = false]) => value is bool ? value : fallback;

DateTime? _date(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value)?.toLocal();
}

Map<String, dynamic> _obj(Object? value) =>
    value is Map ? value.map((key, item) => MapEntry('$key', item)) : const <String, dynamic>{};

List<dynamic> _list(Object? value) => value is List ? value : const <dynamic>[];

Map<String, double> _numberMap(Object? value) {
  final out = <String, double>{};
  _obj(value).forEach((key, item) {
    final number = _num(item);
    if (number != null) out[key] = number;
  });
  return out;
}

class ExpiryThresholds {
  const ExpiryThresholds({this.criticalDays = 3, this.warningDays = 7});

  final int criticalDays;
  final int warningDays;

  factory ExpiryThresholds.fromJson(Map<String, dynamic> json) => ExpiryThresholds(
        criticalDays: _int(json['criticalDays']) ?? 3,
        warningDays: _int(json['warningDays']) ?? 7,
      );
}

class DashboardTotals {
  const DashboardTotals({
    this.providers = 0,
    this.ok = 0,
    this.failed = 0,
    this.availableByCurrency = const {},
    this.creditsByCurrency = const {},
    this.balanceByCurrency = const {},
  });

  final int providers;
  final int ok;
  final int failed;
  final Map<String, double> availableByCurrency;
  final Map<String, double> creditsByCurrency;
  final Map<String, double> balanceByCurrency;

  factory DashboardTotals.fromJson(Map<String, dynamic> json) => DashboardTotals(
        providers: _int(json['providers']) ?? 0,
        ok: _int(json['ok']) ?? 0,
        failed: _int(json['failed']) ?? 0,
        availableByCurrency: _numberMap(json['availableByCurrency']),
        creditsByCurrency: _numberMap(json['creditsByCurrency']),
        balanceByCurrency: _numberMap(json['balanceByCurrency']),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'providers': providers,
        'ok': ok,
        'failed': failed,
        'availableByCurrency': availableByCurrency,
        'creditsByCurrency': creditsByCurrency,
        'balanceByCurrency': balanceByCurrency,
      };
}

class MoneyBalance {
  const MoneyBalance({required this.amount, required this.currency});

  final double amount;
  final String currency;

  factory MoneyBalance.fromJson(Map<String, dynamic> json) => MoneyBalance(
        amount: _num(json['amount']) ?? 0,
        currency: _str(json['currency'], 'CREDITS'),
      );

  Map<String, dynamic> toJson() => {'amount': amount, 'currency': currency};
}

class CreditLot {
  const CreditLot({
    required this.id,
    required this.label,
    required this.amount,
    required this.currency,
    this.expiresAt,
    this.note = '',
    this.basis = 'remaining',
    this.granted,
  });

  final String id;
  final String label;
  final double amount;
  final String currency;
  final DateTime? expiresAt;
  final String note;

  /// `remaining`（默认）或 `granted`：后者只展示到期时间，不参与汇总。
  final String basis;
  final double? granted;

  bool get isGranted => basis == 'granted';

  factory CreditLot.fromJson(Map<String, dynamic> json) => CreditLot(
        id: _str(json['id']),
        label: _str(json['label']),
        amount: _num(json['amount']) ?? 0,
        currency: _str(json['currency'], 'CREDITS'),
        expiresAt: _date(json['expiresAt']),
        note: _str(json['note']),
        basis: _str(json['basis'], 'remaining'),
        granted: _num(json['granted']),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'label': label,
        'amount': amount,
        'currency': currency,
        'expiresAt': expiresAt?.toUtc().toIso8601String(),
        'note': note,
        'basis': basis,
        'granted': granted,
      };
}

class QuotaWindow {
  const QuotaWindow({
    required this.kind,
    required this.label,
    required this.used,
    required this.limit,
    required this.remaining,
    required this.usedPercent,
    required this.remainingPercent,
    required this.boundary,
    this.resetsAt,
    this.expiresAt,
    this.showMeter = false,
  });

  final String kind;
  final String label;
  final double used;
  final double limit;
  final double remaining;
  final double usedPercent;
  final double remainingPercent;
  final String boundary;
  final DateTime? resetsAt;
  final DateTime? expiresAt;
  final bool showMeter;

  factory QuotaWindow.fromJson(Map<String, dynamic> json) => QuotaWindow(
        kind: _str(json['kind']),
        label: _str(json['label']),
        used: _num(json['used']) ?? 0,
        limit: _num(json['limit']) ?? 0,
        remaining: _num(json['remaining']) ?? 0,
        usedPercent: _num(json['usedPercent']) ?? 0,
        remainingPercent: _num(json['remainingPercent']) ?? 0,
        boundary: _str(json['boundary'], 'mixed'),
        resetsAt: _date(json['resetsAt']),
        expiresAt: _date(json['expiresAt']),
        showMeter: _bool(json['showMeter']),
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'kind': kind,
        'label': label,
        'used': used,
        'limit': limit,
        'remaining': remaining,
        'usedPercent': usedPercent,
        'remainingPercent': remainingPercent,
        'boundary': boundary,
        'resetsAt': resetsAt?.toUtc().toIso8601String(),
        'expiresAt': expiresAt?.toUtc().toIso8601String(),
        'showMeter': showMeter,
      };
}

class UsageSources {
  const UsageSources({
    this.todayUsed = 'local',
    this.yesterdayUsed = 'local',
    this.todayAdded = 'local',
    this.yesterdayAdded = 'local',
  });

  final String todayUsed;
  final String yesterdayUsed;
  final String todayAdded;
  final String yesterdayAdded;

  String forField(String field) => switch (field) {
        'todayUsed' => todayUsed,
        'yesterdayUsed' => yesterdayUsed,
        'todayAdded' => todayAdded,
        'yesterdayAdded' => yesterdayAdded,
        _ => 'local',
      };

  factory UsageSources.fromJson(Map<String, dynamic> json) => UsageSources(
        todayUsed: _str(json['todayUsed'], 'local'),
        yesterdayUsed: _str(json['yesterdayUsed'], 'local'),
        todayAdded: _str(json['todayAdded'], 'local'),
        yesterdayAdded: _str(json['yesterdayAdded'], 'local'),
      );

  Map<String, dynamic> toJson() => {
        'todayUsed': todayUsed,
        'yesterdayUsed': yesterdayUsed,
        'todayAdded': todayAdded,
        'yesterdayAdded': yesterdayAdded,
      };
}

class DailyUsage {
  const DailyUsage({
    this.todayUsed,
    this.yesterdayUsed,
    this.todayAdded,
    this.yesterdayAdded,
    this.currency = 'CREDITS',
    this.sources = const UsageSources(),
  });

  final double? todayUsed;
  final double? yesterdayUsed;
  final double? todayAdded;
  final double? yesterdayAdded;
  final String currency;
  final UsageSources sources;

  factory DailyUsage.fromJson(Map<String, dynamic> json) => DailyUsage(
        todayUsed: _num(json['todayUsed']),
        yesterdayUsed: _num(json['yesterdayUsed']),
        todayAdded: _num(json['todayAdded']),
        yesterdayAdded: _num(json['yesterdayAdded']),
        currency: _str(json['currency'], 'CREDITS'),
        sources: UsageSources.fromJson(_obj(json['sources'])),
      );
}

class SecretRef {
  const SecretRef({
    required this.key,
    required this.label,
    required this.preview,
    this.hint = '',
  });

  final String key;
  final String label;
  final String preview;
  final String hint;

  factory SecretRef.fromJson(Map<String, dynamic> json) => SecretRef(
        key: _str(json['key']),
        label: _str(json['label']),
        preview: _str(json['preview']),
        hint: _str(json['hint']),
      );
}

class ProviderEntry {
  const ProviderEntry({
    required this.id,
    required this.label,
    required this.amount,
    required this.currency,
    required this.status,
    this.message,
    this.note,
    this.secrets = const [],
  });

  final String id;
  final String label;
  final double amount;
  final String currency;
  final String status;
  final String? message;
  final String? note;
  final List<SecretRef> secrets;

  bool get healthy => status == 'ok' || status == 'demo';

  factory ProviderEntry.fromJson(Map<String, dynamic> json) => ProviderEntry(
        id: _str(json['id']),
        label: _str(json['label']),
        amount: _num(json['amount']) ?? 0,
        currency: _str(json['currency'], 'CREDITS'),
        status: _str(json['status'], 'error'),
        message: _strOrNull(json['message']),
        note: _strOrNull(json['note']),
        secrets: _list(json['secrets']).map((item) => SecretRef.fromJson(_obj(item))).toList(),
      );
}

class ProviderSnapshot {
  const ProviderSnapshot({
    required this.provider,
    required this.displayName,
    this.accountId = '',
    this.groupAccounts = false,
    this.neverExpires = false,
    this.manageAccounts = false,
    this.entries = const [],
    this.region = 'cn',
    required this.status,
    this.source = 'api',
    this.updatedAt,
    this.plan,
    this.balance,
    this.credits = const [],
    this.windows = const [],
    this.nextExpiryAt,
    this.nextExpiryInDays,
    this.dashboardUrl = '',
    this.usageUrl = '',
    this.message,
    this.note,
    this.secrets = const [],
    this.stale = false,
    this.dailyUsage,
  });

  final String provider;
  final String displayName;
  final String accountId;
  final bool groupAccounts;
  final bool neverExpires;
  final bool manageAccounts;
  final List<ProviderEntry> entries;
  final String region;
  final String status;
  final String source;
  final DateTime? updatedAt;
  final String? plan;
  final MoneyBalance? balance;
  final List<CreditLot> credits;
  final List<QuotaWindow> windows;
  final DateTime? nextExpiryAt;
  final double? nextExpiryInDays;
  final String dashboardUrl;
  final String usageUrl;
  final String? message;
  final String? note;
  final List<SecretRef> secrets;
  final bool stale;
  final DailyUsage? dailyUsage;

  bool get healthy => status == 'ok' || status == 'demo';

  /// 可用额度：优先账户余额，没有余额字段时退回剩余批次之和（口径同 `app.js:253`）。
  double get balanceAmount =>
      balance?.amount ?? credits.fold<double>(0, (sum, lot) => sum + lot.amount);

  String get currency => balance?.currency ?? (credits.isNotEmpty ? credits.first.currency : 'CREDITS');

  factory ProviderSnapshot.fromJson(Map<String, dynamic> json) => ProviderSnapshot(
        provider: _str(json['provider']),
        displayName: _str(json['displayName']),
        accountId: _str(json['accountId']),
        groupAccounts: _bool(json['groupAccounts']),
        neverExpires: _bool(json['neverExpires']),
        manageAccounts: _bool(json['manageAccounts']),
        entries: _list(json['entries']).map((item) => ProviderEntry.fromJson(_obj(item))).toList(),
        region: _str(json['region'], 'cn'),
        status: _str(json['status'], 'error'),
        source: _str(json['source'], 'api'),
        updatedAt: _date(json['updatedAt']),
        plan: _strOrNull(json['plan']),
        balance: json['balance'] == null ? null : MoneyBalance.fromJson(_obj(json['balance'])),
        credits: _list(json['credits']).map((item) => CreditLot.fromJson(_obj(item))).toList(),
        windows: _list(json['windows']).map((item) => QuotaWindow.fromJson(_obj(item))).toList(),
        nextExpiryAt: _date(json['nextExpiryAt']),
        nextExpiryInDays: _num(json['nextExpiryInDays']),
        dashboardUrl: _str(json['dashboardUrl']),
        usageUrl: _str(json['usageUrl']),
        message: _strOrNull(json['message']),
        note: _strOrNull(json['note']),
        secrets: _list(json['secrets']).map((item) => SecretRef.fromJson(_obj(item))).toList(),
        stale: _bool(json['stale']),
        dailyUsage: json['dailyUsage'] == null ? null : DailyUsage.fromJson(_obj(json['dailyUsage'])),
      );
}

class ExpiryHit {
  const ExpiryHit({
    required this.provider,
    required this.displayName,
    required this.lotId,
    required this.lotLabel,
    required this.amount,
    this.granted,
    required this.currency,
    required this.expiresAt,
    required this.inDays,
    this.cny,
    this.cnyNote,
  });

  final String provider;
  final String displayName;
  final String lotId;
  final String lotLabel;
  final double amount;
  final double? granted;
  final String currency;
  final DateTime expiresAt;
  final double inDays;
  final double? cny;
  final String? cnyNote;

  factory ExpiryHit.fromJson(Map<String, dynamic> json) => ExpiryHit(
        provider: _str(json['provider']),
        displayName: _str(json['displayName']),
        lotId: _str(json['lotId']),
        lotLabel: _str(json['lotLabel']),
        amount: _num(json['amount']) ?? 0,
        granted: _num(json['granted']),
        currency: _str(json['currency'], 'CREDITS'),
        expiresAt: _date(json['expiresAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
        inDays: _num(json['inDays']) ?? 0,
        cny: _num(json['cny']),
        cnyNote: _strOrNull(json['cnyNote']),
      );
}

class DashboardPayload {
  const DashboardPayload({
    this.generatedAt,
    this.cacheTtlSeconds = 300,
    this.expiryThresholds = const ExpiryThresholds(),
    this.totals = const DashboardTotals(),
    this.nextExpiry,
    this.expiryTimeline = const [],
    this.providers = const [],
    this.warnings = const [],
    this.missingEnvVars = const [],
  });

  final DateTime? generatedAt;
  final int cacheTtlSeconds;
  final ExpiryThresholds expiryThresholds;
  final DashboardTotals totals;
  final ExpiryHit? nextExpiry;
  final List<ExpiryHit> expiryTimeline;
  final List<ProviderSnapshot> providers;
  final List<String> warnings;
  final List<String> missingEnvVars;

  factory DashboardPayload.fromJson(Map<String, dynamic> json) => DashboardPayload(
        generatedAt: _date(json['generatedAt']),
        cacheTtlSeconds: _int(json['cacheTtlSeconds']) ?? 300,
        expiryThresholds: ExpiryThresholds.fromJson(_obj(json['expiryThresholds'])),
        totals: DashboardTotals.fromJson(_obj(json['totals'])),
        nextExpiry: json['nextExpiry'] == null ? null : ExpiryHit.fromJson(_obj(json['nextExpiry'])),
        expiryTimeline:
            _list(json['expiryTimeline']).map((item) => ExpiryHit.fromJson(_obj(item))).toList(),
        providers:
            _list(json['providers']).map((item) => ProviderSnapshot.fromJson(_obj(item))).toList(),
        warnings: _list(json['warnings']).map((item) => '$item').toList(),
        missingEnvVars: _list(json['missingEnvVars']).map((item) => '$item').toList(),
      );
}

/* ------------------------------------------------------------------ *
 * 平台注册表（/api/providers）
 * ------------------------------------------------------------------ */

class LoginInfo {
  const LoginInfo({required this.label, this.hint = '', this.qr = false});

  final String label;
  final String hint;
  final bool qr;

  factory LoginInfo.fromJson(Map<String, dynamic> json) => LoginInfo(
        label: _str(json['label']),
        hint: _str(json['hint']),
        qr: _bool(json['qr']),
      );
}

class LoginMethod {
  const LoginMethod({
    required this.id,
    required this.label,
    this.hint = '',
    this.qr = false,
    this.kind = 'link',
  });

  final String id;
  final String label;
  final String hint;
  final bool qr;

  /// `scan` / `link` / `web`
  final String kind;

  factory LoginMethod.fromJson(Map<String, dynamic> json) => LoginMethod(
        id: _str(json['id'], 'default'),
        label: _str(json['label']),
        hint: _str(json['hint']),
        qr: _bool(json['qr']),
        kind: _str(json['kind'], _bool(json['qr']) ? 'scan' : 'link'),
      );
}

class ManageField {
  const ManageField({
    required this.key,
    required this.label,
    this.placeholder = '',
    this.hint = '',
    this.required = true,
    this.multiline = false,
    this.secret = true,
    this.target = 'credential',
    this.choices = const [],
    this.defaultValue,
    this.pairedWith = '',
    this.flagGroup = '',
  });

  final String key;
  final String label;
  final String placeholder;
  final String hint;
  final bool required;
  final bool multiline;
  final bool secret;

  /// `credential`（落 .env）或 `option`（落 accounts.json options）
  final String target;
  final List<String> choices;
  final String? defaultValue;
  final String pairedWith;
  final String flagGroup;

  bool get isOption => target == 'option';
  bool get isSelect => choices.isNotEmpty;

  factory ManageField.fromJson(Map<String, dynamic> json) => ManageField(
        key: _str(json['key']),
        label: _str(json['label']),
        placeholder: _str(json['placeholder']),
        hint: _str(json['hint']),
        required: json['required'] == null || _bool(json['required'], true),
        multiline: _bool(json['multiline']),
        secret: json['secret'] == null || _bool(json['secret'], true),
        target: _str(json['target'], 'credential'),
        choices: _list(json['choices']).map((item) => '$item').toList(),
        defaultValue: _strOrNull(json['defaultValue']),
        pairedWith: _str(json['pairedWith']),
        flagGroup: _str(json['flagGroup']),
      );
}

class ProviderMeta {
  const ProviderMeta({
    required this.id,
    required this.displayName,
    this.region = 'cn',
    this.dashboardUrl = '',
    this.credentialHint = '',
    this.requiredCredentialKeys = const [],
    this.isDemo = false,
    this.groupAccounts = false,
    this.manageAccounts = false,
    this.manageFields = const [],
    this.manageHint = '',
    this.login,
    this.loginMethods = const [],
  });

  final String id;
  final String displayName;
  final String region;
  final String dashboardUrl;
  final String credentialHint;
  final List<String> requiredCredentialKeys;
  final bool isDemo;
  final bool groupAccounts;
  final bool manageAccounts;
  final List<ManageField> manageFields;
  final String manageHint;
  final LoginInfo? login;
  final List<LoginMethod> loginMethods;

  bool get hasLogin => loginMethods.isNotEmpty;

  factory ProviderMeta.fromJson(Map<String, dynamic> json) {
    final methods = _list(json['loginMethods'])
        .map((item) => LoginMethod.fromJson(_obj(item)))
        .toList();
    return ProviderMeta(
      id: _str(json['id']),
      displayName: _str(json['displayName']),
      region: _str(json['region'], 'cn'),
      dashboardUrl: _str(json['dashboardUrl']),
      credentialHint: _str(json['credentialHint']),
      requiredCredentialKeys: _list(json['requiredCredentialKeys']).map((item) => '$item').toList(),
      isDemo: _bool(json['isDemo']),
      groupAccounts: _bool(json['groupAccounts']),
      manageAccounts: _bool(json['manageAccounts']),
      manageFields: _list(json['manageFields']).map((item) => ManageField.fromJson(_obj(item))).toList(),
      manageHint: _str(json['manageHint']),
      login: json['login'] == null ? null : LoginInfo.fromJson(_obj(json['login']!)),
      loginMethods: methods,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 账号管理（/api/accounts*）
 * ------------------------------------------------------------------ */

class ManagedAccount {
  const ManagedAccount({
    required this.id,
    required this.label,
    this.enabled = true,
    this.complete = true,
    this.previews = const {},
    this.envRefs = const [],
    this.options = const {},
  });

  final String id;
  final String label;
  final bool enabled;
  final bool complete;
  final Map<String, String> previews;
  final List<String> envRefs;
  final Map<String, String> options;

  factory ManagedAccount.fromJson(Map<String, dynamic> json) => ManagedAccount(
        id: _str(json['id']),
        label: _str(json['label']),
        enabled: _bool(json['enabled'], true),
        complete: _bool(json['complete'], true),
        previews: _obj(json['previews']).map((key, value) => MapEntry(key, _str(value))),
        envRefs: _list(json['envRefs']).map((item) => '$item').toList(),
        options: _obj(json['options']).map((key, value) => MapEntry(key, _str(value))),
      );
}

class AccountsList {
  const AccountsList({this.provider = '', this.accounts = const [], this.warnings = const [], this.missingEnvVars = const []});

  final String provider;
  final List<ManagedAccount> accounts;
  final List<String> warnings;
  final List<String> missingEnvVars;

  factory AccountsList.fromJson(Map<String, dynamic> json) => AccountsList(
        provider: _str(json['provider']),
        accounts: _list(json['accounts']).map((item) => ManagedAccount.fromJson(_obj(item))).toList(),
        warnings: _list(json['warnings']).map((item) => '$item').toList(),
        missingEnvVars: _list(json['missingEnvVars']).map((item) => '$item').toList(),
      );
}

class PlatformOverview {
  const PlatformOverview({
    required this.id,
    required this.displayName,
    this.region = 'cn',
    this.credentialHint = '',
    this.manageAccounts = false,
    this.manageFields = const [],
    this.manageHint = '',
    this.login,
    this.accounts = const [],
    this.warnings = const [],
  });

  final String id;
  final String displayName;
  final String region;
  final String credentialHint;
  final bool manageAccounts;
  final List<ManageField> manageFields;
  final String manageHint;
  final LoginInfo? login;
  final List<ManagedAccount> accounts;
  final List<String> warnings;

  factory PlatformOverview.fromJson(Map<String, dynamic> json) => PlatformOverview(
        id: _str(json['id']),
        displayName: _str(json['displayName']),
        region: _str(json['region'], 'cn'),
        credentialHint: _str(json['credentialHint']),
        manageAccounts: _bool(json['manageAccounts']),
        manageFields: _list(json['manageFields']).map((item) => ManageField.fromJson(_obj(item))).toList(),
        manageHint: _str(json['manageHint']),
        login: json['login'] == null ? null : LoginInfo.fromJson(_obj(json['login']!)),
        accounts:
            _list(json['accounts']).map((item) => ManagedAccount.fromJson(_obj(item))).toList(),
        warnings: _list(json['warnings']).map((item) => '$item').toList(),
      );

  ProviderMeta toMeta({List<LoginMethod> loginMethods = const []}) => ProviderMeta(
        id: id,
        displayName: displayName,
        region: region,
        credentialHint: credentialHint,
        manageAccounts: manageAccounts,
        manageFields: manageFields,
        manageHint: manageHint,
        login: login,
        loginMethods: loginMethods,
      );
}

class AccountsOverview {
  const AccountsOverview({
    this.accountsFilePath = '',
    this.warnings = const [],
    this.missingEnvVars = const [],
    this.providers = const [],
  });

  final String accountsFilePath;
  final List<String> warnings;
  final List<String> missingEnvVars;
  final List<PlatformOverview> providers;

  factory AccountsOverview.fromJson(Map<String, dynamic> json) => AccountsOverview(
        accountsFilePath: _str(json['accountsFilePath']),
        warnings: _list(json['warnings']).map((item) => '$item').toList(),
        missingEnvVars: _list(json['missingEnvVars']).map((item) => '$item').toList(),
        providers:
            _list(json['providers']).map((item) => PlatformOverview.fromJson(_obj(item))).toList(),
      );
}

/* ------------------------------------------------------------------ *
 * 登录会话（src/login-session.ts:34）
 * ------------------------------------------------------------------ */

class LoginSessionView {
  const LoginSessionView({
    required this.id,
    required this.provider,
    required this.method,
    required this.status,
    this.authUrl,
    this.qr = false,
    this.hint = '',
    this.message,
    this.account,
    this.expiresAt,
  });

  final String id;
  final String provider;
  final String method;
  final String status;
  final String? authUrl;
  final bool qr;
  final String hint;
  final String? message;
  final ({String name, bool updated})? account;
  final DateTime? expiresAt;

  bool get terminal => const {'ready', 'expired', 'failed', 'cancelled', 'invalid'}.contains(status);

  factory LoginSessionView.fromJson(Map<String, dynamic> json) {
    final account = json['account'];
    return LoginSessionView(
      id: _str(json['id']),
      provider: _str(json['provider']),
      method: _str(json['method'], 'default'),
      status: _str(json['status']),
      authUrl: _strOrNull(json['authUrl']),
      qr: _bool(json['qr']),
      hint: _str(json['hint']),
      message: _strOrNull(json['message']),
      account: account is Map
          ? (name: _str(account['name']), updated: _bool(account['updated']))
          : null,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(_int(json['expiresAt']) ?? 0),
    );
  }

  LoginSessionView copyWith({String? status, String? authUrl, String? message}) => LoginSessionView(
        id: id,
        provider: provider,
        method: method,
        status: status ?? this.status,
        authUrl: authUrl,
        qr: qr,
        hint: hint,
        message: message ?? this.message,
        account: account,
        expiresAt: expiresAt,
      );
}
