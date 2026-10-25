import type { AccountConfig } from '../config.js';
import type { ManageFieldDescriptor, ProviderAdapter } from './base.js';
import { codeartsAdapter } from './codearts.js';
import { codebuddyAdapter, codebuddyIntlAdapter } from './codebuddy.js';
import { a1etheropenaiAdapter } from './a1etheropenai.js';
import { demoAdapters } from './demo.js';
import { minimaxAdapter } from './minimax.js';
import { sessionApiAdapters } from './presets.js';
import { qoderAdapter, qoderIntlAdapter } from './qoder.js';
import { traeAdapter } from './trae.js';

/**
 * 适配器注册表。新增平台 = 新增一个 ProviderAdapter + 在这里注册一行。
 * 与 token-monitor 的 providers/ 目录、CodexBar 的 Providers/ 目录是同一思路。
 */
const REGISTRY = new Map<string, ProviderAdapter>();

for (const adapter of [
  qoderAdapter,
  qoderIntlAdapter,
  traeAdapter,
  codebuddyAdapter,
  codebuddyIntlAdapter,
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
 *   - 精确匹配（qoder / qoder-intl / trae / codebuddy / codearts / custom / demo:qoder ...）
 *   - 别名回退：qoder-cn / qoder.com.cn -> qoder，qoder-global / qoder.com -> qoder-intl，
 *     trae-cn -> trae
 *
 * Qoder 的两个站点是两个平台（`qoder` 国内版 / `qoder-intl` 国际版），
 * 别名按域名归属分流，不再有「一个平台带站点选项」的写法。
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
  'qoder.com': 'qoder-intl',
  'qoder.com.cn': 'qoder',
  'qoder.cn': 'qoder',
  'qoder-cn': 'qoder',
  'qoder-global': 'qoder-intl',
  'trae.cn': 'trae',
  'trae.com.cn': 'trae',
  'trae-cn': 'trae',
  'www.trae.cn': 'trae',
  'codebuddy.cn': 'codebuddy',
  'www.codebuddy.cn': 'codebuddy',
  'copilot.tencent.com': 'codebuddy',
  'codebuddy.ai': 'codebuddy-intl',
  'www.codebuddy.ai': 'codebuddy-intl',
  'workbuddy': 'codebuddy-intl',
  'workbuddy.ai': 'codebuddy-intl',
  'www.workbuddy.ai': 'codebuddy-intl',
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
  /**
   * 登录方法完整清单（带 `id` / `kind`），前端据此渲染 N 个登录按钮。
   * 未声明 `loginMethods` 的平台回退为 `login` 单方法清单（id 缺省），
   * 因此前端可以只按 `loginMethods` 渲染，不必两处判断。
   */
  loginMethods: Array<{ id: string; label: string; hint: string; qr: boolean; kind: string }>;
}> {
  return listAdapters()
    .map((adapter) => {
      const describeLogin = (login: NonNullable<ProviderAdapter['login']>, id: string) => ({
        id,
        label: login.label,
        hint: login.hint,
        qr: login.qr,
        kind: login.kind ?? (login.qr ? 'scan' : 'link'),
      });
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        region: adapter.region,
        dashboardUrl: adapter.dashboardUrl,
        credentialHint: adapter.credentialHint,
        requiredCredentialKeys: adapter.requiredCredentialKeys,
        isDemo: adapter.id.startsWith('demo:'),
        groupAccounts: adapter.groupAccounts === true,
        manageAccounts: adapter.manageAccounts === true,
        // 成组语义（如 CodeArts 的 SecretKey 跟随 AccessKey）要在前端生效，必须显式透出；
        // JSON 会丢掉 undefined，因此逐项落成具体值
        manageFields: (adapter.manageFields ?? []).map((field) => ({
          ...field,
          required: field.required !== false,
          pairedWith: field.pairedWith ?? '',
          flagGroup: field.flagGroup ?? '',
        })),
        manageHint: adapter.manageHint ?? '',
        login: adapter.login
          ? { label: adapter.login.label, hint: adapter.login.hint, qr: adapter.login.qr }
          : null,
        loginMethods: (adapter.loginMethods?.length
          ? adapter.loginMethods
          : adapter.login
            ? [adapter.login]
            : []
        ).map((method, index) =>
          describeLogin(method, method.id ?? (index === 0 ? 'default' : `method-${index}`)),
        ),
      };
    })
    .sort((a, b) => Number(a.isDemo) - Number(b.isDemo) || a.id.localeCompare(b.id));
}

export type { AccountConfig, ProviderAdapter };
