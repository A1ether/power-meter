import 'dart:math' as math;

import 'package:intl/intl.dart';

/// 数字 / 日期 / 过期文案的统一口径，对应 `public/app.js:181-260`。
///
/// 用固定 `en_US` 分组格式而不是依赖运行环境 locale：本项目只面向中文界面，
/// 中英文的千分位与小数点一致，这样 Web / 桌面 / 移动三端输出完全相同。
final NumberFormat _numberFormat = NumberFormat('#,##0.##', 'en_US');
final NumberFormat _cnyFormat = NumberFormat('#,##0.00', 'en_US');

String fmtNumber(num? value) {
  if (value == null || value.isNaN || value.isInfinite) return '–';
  return _numberFormat.format(value);
}

/// 人民币估值：空值返回空串（整块不渲染，不留「¥–」）。
String fmtCny(num? value) {
  if (value == null || value.isNaN) return '';
  return '¥${_cnyFormat.format(value)}';
}

String _pad(int value) => value.toString().padLeft(2, '0');

String fmtDate(DateTime? value) {
  if (value == null) return '未知';
  final local = value.toLocal();
  return '${local.year}/${_pad(local.month)}/${_pad(local.day)} '
      '${_pad(local.hour)}:${_pad(local.minute)}';
}

String pluralizeDays(double days) {
  final abs = days.abs();
  if (abs < 1) {
    final hours = math.max(0, (abs * 24).round());
    return '$hours 小时';
  }
  return '${abs.round()} 天';
}

String expiryText(double? inDays) {
  if (inDays == null || inDays.isNaN) return '无过期时间';
  if (inDays < 0) return '已过期 ${pluralizeDays(inDays)}';
  if (inDays < 1 / 24) return '不足 1 小时';
  return '${pluralizeDays(inDays)}后到期';
}

/// 到期紧迫度。`none` 表示没有到期概念（或已过期，按 `app.js:229` 的口径）。
enum ExpiryLevel { none, critical, warning, safe }

ExpiryLevel levelFor(double? inDays, {required int criticalDays, required int warningDays}) {
  if (inDays == null || inDays.isNaN) return ExpiryLevel.none;
  if (inDays < 0) return ExpiryLevel.none;
  if (inDays <= criticalDays) return ExpiryLevel.critical;
  if (inDays <= warningDays) return ExpiryLevel.warning;
  return ExpiryLevel.safe;
}

double? daysUntil(DateTime? value, {DateTime? now}) {
  if (value == null) return null;
  final current = now ?? DateTime.now();
  return value.difference(current).inMilliseconds / 86400000;
}

const Map<String, String> usageSourceLabels = {
  'upstream': '平台明细',
  'local': '本地采样',
  'mixed': '明细 + 采样',
};

class UsageField {
  const UsageField(this.key, this.label, this.hint, {this.increase = false});

  final String key;
  final String label;
  final String hint;
  final bool increase;
}

const List<UsageField> usageFields = [
  UsageField('todayUsed', '今日用量', '今天已使用的额度'),
  UsageField('yesterdayUsed', '昨日用量', '昨天一整天使用的额度'),
  UsageField('todayAdded', '今日增量', '今天新增的额度', increase: true),
  UsageField('yesterdayAdded', '昨日增量', '昨天新增的额度', increase: true),
];

const Map<String, String> loginStatusText = {
  'waiting': '等待授权…',
  'landing': '正在接收授权回调…',
  'ready': '登录成功',
  'expired': '登录会话已过期',
  'failed': '登录失败',
  'cancelled': '已取消登录',
  'invalid': '登录会话已失效',
};
