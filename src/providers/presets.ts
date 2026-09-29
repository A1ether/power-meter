import { createSessionApiAdapter, type SessionApiPreset } from './sessionApi.js';
import type { ProviderAdapter } from './base.js';

/**
 * 通用兜底适配器：任何没有内置适配器的平台都能靠「端点 + 字段映射」接进来。
 *
 * 思路借鉴 MeIotCOM/CodingPlanQuota 的 Custom / Relay（声明式 JSON 路径映射）。
 * CodeBuddy 与 CodeArts 曾经也走这条路，但在 `npm run capture` 定位到真实接口后
 * 已经升级为专用适配器（src/providers/codebuddy.ts / codearts.ts），
 * 无论从易用性还是容错性上都更好。
 */

export const customPreset: SessionApiPreset = {
  id: 'custom',
  displayName: '自定义平台',
  region: 'global',
  dashboardUrl: '',
  requiredCredentialKeys: [],
  credentialHint: '按需在 options.headers 中提供鉴权头。',
  defaultEndpoint: '',
  defaultMethod: 'GET',
  defaultMapping: {
    balance: { path: 'balance|remaining|amount', currency: 'CREDITS' },
    creditLots: {
      path: 'credits|packs|items',
      amount: 'remaining|amount|balance',
      expiresAt: 'expiresAt|expireTime|validUntil',
      label: 'name|label|title',
      currency: 'CREDITS',
    },
    plan: 'plan|planName|tier',
  },
  setupHint: [
    '为自定义平台配置 options.endpoint、options.mapping、options.headers、options.displayName。',
    '同款配置可复制多份，用 options.providerId 区分（如 custom-a / custom-b），即可并列展示多个平台。',
    '字段路径支持 "a.b[0].c" 与 "a|b"（候选字段）两种写法。',
  ].join('\n'),
};

export const sessionApiAdapters: ProviderAdapter[] = [createSessionApiAdapter(customPreset)];
