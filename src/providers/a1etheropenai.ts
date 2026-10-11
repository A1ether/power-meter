import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { ProviderStatus, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractHeaderValue,
  failure,
  joinNotes,
  notConfigured,
  optBool,
  optString,
  type ProbeContext,
  type ProviderAdapter,
  type SecretDescriptor,
} from './base.js';

/**
 * A1etherOpenAi（d1v.ai）
 *
 * 纯 API 密钥，不需要浏览器登录态，且分两层密钥：
 *
 *   ① 个人账号 API 密钥（`A1etherOpenAi_API_KEY`，`sk-...`）
 *      —— 在 https://www.d1v.ai/settings?tab=api-key 创建，可查额度。
 *   ② 项目环境密钥（`A1etherOpenAi_PAI_API_KEY`）
 *      —— 在项目 Dashboard 的 Create Project Environment 后生成，
 *         只用于调模型（`https://pai.d1v.ai/v1`），**不能**查额度。
 *         本适配器不拿它取数，只把它登记为「可托管密钥」。
 *
 * ============================ 单位口径 ============================
 *
 * 只看 **quota**。平台有两套计量，但只有一套有意义：
 *
 *   · `quota_remaining`（QUOTA）：模型调用实际扣减的单位，**永不过期**。
 *     账号能不能用，只取决于它。
 *   · 钱包 USD：记账用的账面数字，而且**系统性虚高**——
 *     实测两个独立账号，钱包都比 quota 折合值多出恒定 $2.00
 *     （1 USD = 500,000 quota，4 条扣减记录全部精确吻合）。
 *     既然 quota 不过期、USD 又不参与实际消耗，看板就完全不显示它：
 *     显示一个用不上、还偏大的数字只会误导人。
 *
 * 因此本适配器**不请求** `/api/wallet/balances`，也不产出任何带到期时间的
 * 批次 —— quota 不过期，就不该出现在「最快到期」里跟别的平台抢注意力。
 *
 * ============================ 一张卡片 ============================
 *
 * 一个账号 = 一把项目密钥 + 一份 quota，天然是「同一个东西的多份」，
 * 所以声明 `groupAccounts: true`：所有 A1etherOpenAi 账号合并成一张卡片，
 * 卡片里一条条列出「托管密钥 + 它的 quota」，方便横向对比谁快用完了。
 *
 * ============================ 接口 ============================
 *
 * 来自 https://api.d1v.ai/api/openapi.json（openapi 3.1.0）：
 *   - GET /api/wallet/pai-project-usage/overview → 必备
 *        quota_remaining（可用）/ total_quota（已消耗）/ total_usd
 *        / total_requests / platform_project_count
 *   - GET /api/user/info → email / slug，作为卡片里这条账号的标识
 *
 * 鉴权：`Authorization: Bearer <A1etherOpenAi_API_KEY>`；响应信封统一为
 * `{ code, msg, data }`，`code === 0` 为成功（由 assertBusinessOk 兜底）。
 */

const A1etherOpenAi_API_BASE = 'https://api.d1v.ai';
const A1etherOpenAi_TIMEOUT_FALLBACK = 12_000;

export const a1etheropenaiAdapter: ProviderAdapter = {
  id: 'a1etheropenai',
  displayName: 'A1etherOpenAi',
  region: 'global',
  dashboardUrl: 'https://www.d1v.ai/settings?tab=api-key',
  // A1etherOpenAi 没有公开的用量页，用量区保持纯展示
  usageUrl: '',
  requiredCredentialKeys: ['apiKey'],
  groupAccounts: true,
  // quota 永不过期：卡片上会打一个「永不过期」标签，也不参与「最快到期」
  neverExpires: true,
  // 卡片上直接提供「添加 / 删除账号」的入口
  manageAccounts: true,
  credentialHint:
    '在 https://www.d1v.ai/settings?tab=api-key 创建一把具名密钥（只在创建时完整显示一次），' +
    '填入 credentials.apiKey；' +
    '项目密钥 A1etherOpenAi_PAI_API_KEY 填进 credentials.paiApiKey 后即可在看板上复制。' +
    '推荐直接跑 npm run a1etheropenai:add，不用手工改配置。',
  revealableSecrets(account: AccountConfig): SecretDescriptor[] {
    // 默认只托管项目密钥（它只能调模型，泄露面小）；
    // 账号密钥能查询账户信息，需要显式开启 options.revealApiKey 才允许复制。
    const declared: SecretDescriptor[] = [
      { key: 'paiApiKey', label: 'A1etherOpenAi_PAI_API_KEY', hint: '用于模型调用（pai.d1v.ai/v1）' },
    ];
    if (optBool(account, 'revealApiKey')) {
      declared.push({ key: 'apiKey', label: 'A1etherOpenAi_API_KEY', hint: '个人账号密钥，可查额度' });
    }
    return declared;
  },
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const apiKey = normalizeApiKey(cred(account, ctx, ['apiKey', 'api_token', 'token', 'key']));
    if (!apiKey) return notConfigured(a1etheropenaiAdapter, account, ctx, ['apiKey']);

    const baseUrl = (optString(account, 'baseUrl') || A1etherOpenAi_API_BASE).replace(/\/+$/, '');
    const timeoutMs = ctx.timeoutMs || A1etherOpenAi_TIMEOUT_FALLBACK;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    const degraded: string[] = [];

    const getData = async (path: string): Promise<unknown> => {
      const response = await fetchJson(`${baseUrl}${path}`, { headers, timeoutMs });
      assertBusinessOk(response.body);
      return pick(response.body, 'data');
    };

    try {
      // quota 是唯一的必取项，取不到就没有可展示的额度，直接算失败
      const quota = parseA1etherOpenAiQuota(await getData('/api/wallet/pai-project-usage/overview'));

      // 账号标识只是让卡片好认，取不到不影响额度
      let profile: string | null = null;
      try {
        profile = parseA1etherOpenAiProfile(await getData('/api/user/info'));
      } catch (error) {
        degraded.push(`账号信息（${(error as Error).message}）`);
      }

      const count = (value: number): string => value.toLocaleString('en-US');

      return buildSnapshot({
        adapter: a1etheropenaiAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        plan: profile,
        // 额度以 quota 计，永不过期
        balance: { amount: quota.quotaRemaining, currency: 'QUOTA' },
        credits: [],
        windows: [],
        // 只写用量，不写项目名：项目名是「哪把密钥属于哪个环境」的细节，
        // 在一条账号一行的布局里重复出现只会占地方
        note: joinNotes(
          quota.totalRequests > 0
            ? `已用 ${count(quota.quotaConsumed)} quota（${quota.totalRequests} 次请求）`
            : '尚未产生调用',
          degraded.length > 0 ? `可选接口取数失败：${degraded.join('；')}` : null,
        ),
        // 没有到期概念，别拿窗口重置时间兜底去凑一个「最快到期」
        fallbackExpiryFromWindow: false,
      });
    } catch (error) {
      return failure(
        a1etheropenaiAdapter,
        account,
        ctx,
        businessErrorStatus(error),
        (error as Error).message,
      );
    }
  },
};

/** 兼容三种粘贴形式：裸 key、`Authorization: Bearer sk-...`、"Copy as cURL" 整段 */
export function normalizeApiKey(raw: string): string {
  return extractHeaderValue(raw, 'authorization')
    .replace(/^bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * 业务错误码也映射成状态：上游 401 若被包装成 HTTP 200 + code=401，
 * 只看 HTTP 状态码会退化成万能的 error，界面上就分不清「密钥错了」还是「网络炸了」。
 */
function businessErrorStatus(error: unknown): ProviderStatus {
  if (error instanceof HttpError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthor|invalid api key|bad credentials|not authenticated|invalid token/i.test(message)) {
    return 'unauthorized';
  }
  if (/\b403\b|forbidden/i.test(message)) return 'forbidden';
  if (/\b429\b|too many|rate ?limit/i.test(message)) return 'rateLimited';
  return 'error';
}

export interface A1etherOpenAiQuotaSummary {
  /** 可用 quota —— 唯一决定账号能不能用的数字，永不过期 */
  quotaRemaining: number;
  /** 已消耗的 quota（上游默认窗口内的项目用量累计） */
  quotaConsumed: number;
  usdConsumed: number;
  totalRequests: number;
  projectCount: number;
  projects: Array<{ id: string; name: string }>;
}

export function parseA1etherOpenAiQuota(data: unknown): A1etherOpenAiQuotaSummary {
  if (!isRecord(data)) {
    throw new Error('响应缺少 data 字段（API 密钥可能无效或已被撤销）');
  }
  const quotaRemaining = firstNumber(pick(data, 'quota_remaining', 'quotaRemaining'));
  if (quotaRemaining === null) {
    throw new Error('响应缺少 quota_remaining，无法判断可用额度');
  }

  const projects: Array<{ id: string; name: string }> = [];
  const raw = pick(data, 'projects');
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const id = firstString(pick(item, 'project_id', 'projectId'));
      if (!id) continue;
      projects.push({ id, name: firstString(pick(item, 'project_name', 'projectName')) || id });
    }
  }

  return {
    quotaRemaining,
    quotaConsumed: firstNumber(pick(data, 'total_quota', 'totalQuota')) ?? 0,
    usdConsumed: firstNumber(pick(data, 'total_usd', 'totalUsd')) ?? 0,
    totalRequests: firstNumber(pick(data, 'total_requests', 'totalRequests')) ?? 0,
    projectCount:
      firstNumber(pick(data, 'platform_project_count', 'platformProjectCount')) ?? projects.length,
    projects,
  };
}

/** 多账号托管时，卡片里那条要能看出是哪个账号，所以拿 email / slug 当标识 */
export function parseA1etherOpenAiProfile(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const label = firstString(pick(data, 'email', 'slug', 'company_name', 'sub'));
  return label || null;
}
