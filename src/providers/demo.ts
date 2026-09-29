import type { AccountConfig } from '../config.js';
import type { CreditLot, Currency, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  makeLot,
  makeWindow,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * 示例数据平台（对应 quotio 的 `mock` provider）。
 *
 * 作用：`npm start` 之后立刻看到完整看板效果，无需先配好真实凭证。
 * 数据确定性生成，界面上会明确标注「示例数据」，随时可在 accounts.json 里关掉。
 */

const DAY = 86_400_000;

interface DemoLotConfig {
  label: string;
  amount: number;
  /** NaN 表示没有过期时间 */
  inDays: number;
  note?: string;
}

interface DemoDefinition {
  slug: string;
  displayName: string;
  region: 'cn' | 'global';
  dashboardUrl: string;
  plan: string;
  currency: Currency;
  balance: number;
  lots: DemoLotConfig[];
  windowUsed: number;
  windowLimit: number;
  resetInDays: number;
}

const DEFINITIONS: DemoDefinition[] = [
  {
    slug: 'qoder',
    displayName: 'Qoder（示例）',
    region: 'global',
    dashboardUrl: 'https://qoder.com/account/usage',
    plan: 'Ultra',
    currency: 'CREDITS',
    balance: 1_860,
    lots: [
      { label: '大模型积分（本期剩余）', amount: 1_860, inDays: 6, note: '随本期重置作废' },
      { label: '活动赠送积分', amount: 420, inDays: 41, note: '一次性赠送包' },
    ],
    windowUsed: 4_140,
    windowLimit: 6_000,
    resetInDays: 6,
  },
  {
    slug: 'trae',
    displayName: 'Trae（示例）',
    region: 'cn',
    dashboardUrl: 'https://www.trae.cn/ide/account',
    plan: 'Pro',
    currency: 'CREDITS',
    balance: 730,
    lots: [
      { label: '月度权益包', amount: 300, inDays: 2, note: '原始额度 500，已用 200' },
      { label: '新用户体验包', amount: 430, inDays: 23, note: '原始额度 500，已用 70' },
    ],
    windowUsed: 570,
    windowLimit: 1_300,
    resetInDays: 2,
  },
  {
    slug: 'codebuddy',
    displayName: 'CodeBuddy（示例）',
    region: 'cn',
    dashboardUrl: 'https://www.codebuddy.cn',
    plan: '团队版',
    currency: 'CREDITS',
    balance: 12_400,
    lots: [
      { label: '团队共享积分', amount: 9_400, inDays: 18 },
      { label: '个人补充包', amount: 3_000, inDays: 96 },
    ],
    windowUsed: 2_600,
    windowLimit: 15_000,
    resetInDays: 18,
  },
  {
    slug: 'codearts',
    displayName: 'CodeArts 华为云（示例）',
    region: 'cn',
    dashboardUrl: 'https://codearts.huaweicloud.com',
    plan: '专业版',
    currency: 'CNY',
    balance: 268.5,
    lots: [{ label: '云服务代金券', amount: 268.5, inDays: 11, note: '随代金券有效期作废' }],
    windowUsed: 231.5,
    windowLimit: 500,
    resetInDays: 11,
  },
  {
    slug: 'no-expiry',
    displayName: '示例 · 无过期时间',
    region: 'global',
    dashboardUrl: 'https://example.com/usage',
    plan: 'Free',
    currency: 'CREDITS',
    balance: 90,
    lots: [{ label: '永久积分', amount: 90, inDays: Number.NaN }],
    windowUsed: 10,
    windowLimit: 100,
    resetInDays: Number.NaN,
  },
];

function createDemoAdapter(definition: DemoDefinition): ProviderAdapter {
  const adapter: ProviderAdapter = {
    id: `demo:${definition.slug}`,
    displayName: definition.displayName,
    region: definition.region,
    dashboardUrl: definition.dashboardUrl,
    requiredCredentialKeys: [],
    credentialHint: '示例数据无需凭证，把 accounts.json 里的这条 enabled 改为 false 即可关闭。',
    probe: async (account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> => {
      const iso = (inDays: number): string | null =>
        Number.isFinite(inDays) ? new Date(ctx.now + inDays * DAY).toISOString() : null;

      const credits: CreditLot[] = definition.lots.map((lot, index) =>
        makeLot({
          id: `lot-${index}`,
          label: lot.label,
          amount: lot.amount,
          currency: definition.currency,
          expiresAt: iso(lot.inDays),
          note: lot.note ?? '',
        }),
      );

      const resetAt = iso(definition.resetInDays);

      return buildSnapshot({
        adapter,
        account,
        status: 'demo',
        now: ctx.now,
        source: 'local',
        plan: definition.plan,
        balance: { amount: definition.balance, currency: definition.currency },
        credits,
        windows: [
          makeWindow({
            kind: 'billing',
            label: '本期额度',
            used: definition.windowUsed,
            limit: definition.windowLimit,
            boundary: resetAt ? 'reset' : 'mixed',
            resetsAt: resetAt,
          }),
        ],
        note: '示例数据，用于预览界面',
      });
    },
  };
  return adapter;
}

export const demoAdapters: ProviderAdapter[] = DEFINITIONS.map(createDemoAdapter);

/** 供前端与文档展示的示例平台 id 列表 */
export const DEMO_PROVIDER_IDS: string[] = demoAdapters.map((adapter) => adapter.id);
