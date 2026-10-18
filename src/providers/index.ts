import type { AccountConfig } from '../config.js';
import type { ManageFieldDescriptor, ProviderAdapter } from './base.js';
import { codeartsAdapter } from './codearts.js';
import { codebuddyAdapter } from './codebuddy.js';
import { a1etheropenaiAdapter } from './a1etheropenai.js';
import { demoAdapters } from './demo.js';
import { minimaxAdapter } from './minimax.js';
import { sessionApiAdapters } from './presets.js';
import { qoderAdapter } from './qoder.js';
import { traeAdapter } from './trae.js';

/**
 * 适配器注册表。新增平台 = 新增一个 ProviderAdapter + 在这里注册一行。
 * 与 token-monitor 的 providers/ 目录、CodexBar 的 Providers/ 目录是同一思路。
 */
const REGISTRY = new Map<string, ProviderAdapter>();

for (const adapter of [
  qoderAdapter,
  traeAdapter,
  codebuddyAdapter,
  codeartsAdapter,
  a1etheropenaiAdapter,
  minimaxAdapter,
  ...sessionApiAdapters,
  ...demoAdapters,
]) {
  REGISTRY.set(adapter.id, adapter);
}

export function listAdapters(): ProviderAdapter[] {
  return [...REGISTRY.values()];
}

/**
 * 按 provider id 找适配器，支持：
 *   - 精确匹配（qoder / trae / codebuddy / codearts / custom / demo:qoder ...）
 *   - 别名回退：qoder-cn / qoder.com.cn -> qoder，trae-cn -> trae
 */
export function resolveAdapter(providerId: string): ProviderAdapter | null {
  const normalized = providerId.trim().toLowerCase();
  const direct = REGISTRY.get(normalized);
  if (direct) return direct;

  const alias = ALIASES[normalized];
  if (alias) return REGISTRY.get(alias) ?? null;

  return null;
}

const ALIASES: Record<string, string> = {
  'qoder.com': 'qoder',
  'qoder.com.cn': 'qoder',
  'qoder.cn': 'qoder',
  'qoder-cn': 'qoder',
  'qoder-global': 'qoder',
  'trae.cn': 'trae',
  'trae.com.cn': 'trae',
  'trae-cn': 'trae',
  'www.trae.cn': 'trae',
  'codebuddy.cn': 'codebuddy',
  'www.codebuddy.cn': 'codebuddy',
  'copilot.tencent.com': 'codebuddy',
  'codearts.huaweicloud.com': 'codearts',
  'huaweicloud': 'codearts',
  'devcloud': 'codearts',
  'd1v.ai': 'a1etheropenai',
  'www.d1v.ai': 'a1etheropenai',
  'api.d1v.ai': 'a1etheropenai',
  'pai.d1v.ai': 'a1etheropenai',
  'a1ether-openai': 'a1etheropenai',
  'minimax-code': 'minimax',
  'minimax.cn': 'minimax',
  'minimax.io': 'minimax',
  'agent.minimax.cn': 'minimax',
  'agent.minimax.io': 'minimax',
};

export function describeRegistry(): Array<{
  id: string;
  displayName: string;
  region: 'cn' | 'global';
  dashboardUrl: string;
  credentialHint: string;
  requiredCredentialKeys: string[];
  isDemo: boolean;
  /**
   * 以下四项是「添加 / 删除账号」区的前端依赖：
   * 前端只按声明渲染，不认平台名（见 public/app.js 的 renderManage）。
   */
  groupAccounts: boolean;
  manageAccounts: boolean;
  manageFields: ManageFieldDescriptor[];
  manageHint: string;
  /** 「扫码 / 打开链接登录」入口；未声明为 null（前端据此决定是否渲染） */
  login: { label: string; hint: string; qr: boolean } | null;
}> {
  return listAdapters()
    .map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      region: adapter.region,
      dashboardUrl: adapter.dashboardUrl,
      credentialHint: adapter.credentialHint,
      requiredCredentialKeys: adapter.requiredCredentialKeys,
      isDemo: adapter.id.startsWith('demo:'),
      groupAccounts: adapter.groupAccounts === true,
      manageAccounts: adapter.manageAccounts === true,
      manageFields: adapter.manageFields ?? [],
      manageHint: adapter.manageHint ?? '',
      login: adapter.login
        ? { label: adapter.login.label, hint: adapter.login.hint, qr: adapter.login.qr }
        : null,
    }))
    .sort((a, b) => Number(a.isDemo) - Number(b.isDemo) || a.id.localeCompare(b.id));
}

export type { AccountConfig, ProviderAdapter };
