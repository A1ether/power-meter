import 'package:flutter/material.dart';

enum DashboardSection { overview, providers, timeline, diagnostics }

extension DashboardSectionLabel on DashboardSection {
  String get label => switch (this) {
        DashboardSection.overview => '总览',
        DashboardSection.providers => '额度卡片',
        DashboardSection.timeline => '到期时间线',
        DashboardSection.diagnostics => '诊断',
      };

  String get subtitle => switch (this) {
        DashboardSection.overview => '多平台余额 / 积分看板',
        DashboardSection.providers => '按最快到期排序，优先消耗临期积分',
        DashboardSection.timeline => '按过期时间升序，优先使用排在前面的批次',
        DashboardSection.diagnostics => '凭证与配置问题会在这里提示',
      };

  IconData get icon => switch (this) {
        DashboardSection.overview => Icons.dashboard_outlined,
        DashboardSection.providers => Icons.credit_card_outlined,
        DashboardSection.timeline => Icons.timeline,
        DashboardSection.diagnostics => Icons.monitor_heart_outlined,
      };
}
