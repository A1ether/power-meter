import 'package:flutter/material.dart';

/// 区块顺序即页面顺序：第一项「最先到期」就是首屏。
enum DashboardSection { expiry, overview, providers, diagnostics }

extension DashboardSectionLabel on DashboardSection {
  String get label => switch (this) {
        DashboardSection.expiry => '最先到期',
        DashboardSection.overview => '总览',
        DashboardSection.providers => '额度卡片',
        DashboardSection.diagnostics => '诊断',
      };

  String get subtitle => switch (this) {
        DashboardSection.expiry => '按过期时间升序，优先消耗排在最前面的积分',
        DashboardSection.overview => '多平台余额 / 积分看板',
        DashboardSection.providers => '按最快到期排序，优先消耗临期积分',
        DashboardSection.diagnostics => '凭证与配置问题会在这里提示',
      };

  IconData get icon => switch (this) {
        DashboardSection.expiry => Icons.timeline,
        DashboardSection.overview => Icons.dashboard_outlined,
        DashboardSection.providers => Icons.credit_card_outlined,
        DashboardSection.diagnostics => Icons.monitor_heart_outlined,
      };
}
