import { fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildSnapshot,
  cred,
  extractExpiry,
  failure,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  type ProbeContext,
  type ProviderAdapter,
} from './base.js';

/**
 * Trae（trae.cn）
 *
 * 接口来自开源实现 Javis603/token-monitor
 * (src/shared/providers/trae/limits.js)，并已实测确认：
 *   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
 *   无凭证时返回 401 {"code":1001,...}
 *
 * 认证头：Authorization: Cloud-IDE-JWT <token>，可选 X-Device-Id。
 * 响应中的 user_entitlement_pack_list 是「权益包」列表，逐包累加即得可用积分；
 * 部分包会带过期时间，这里做成批次以便按「最快到期」排序。
 */

const TRAE_API_ORIGIN = 'https://api.trae.cn';
const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const TRAE_TIMEOUT_FALLBACK = 12_000;

export function traeEntUsageUrl(origin = TRAE_API_ORIGIN): string {
  return `${origin}${TRAE_ENT_USAGE_PATH}`;
}

interface TraePack {
  index: number;
  limit: number;
  used: number;
  remaining: number;
  expiresAt: string | null;
  label: string;
}

export function parseTraeEntUsage(body: unknown): {
  packs: TraePack[];
  limit: number;
  used: number;
  remaining: number;
} {
  const container = isRecord(body) && isRecord(body.data) ? body.data : body;
  const list =
    pick(container, 'user_entitlement_pack_list', 'userEntitlementPackList') ??
    (isRecord(body) ? pick(body, 'data', 'user_entitlement_pack_list') : undefined);
  if (!Array.isArray(list)) {
    throw new Error('响应缺少 user_entitlement_pack_list（凭证可能已失效）');
  }

  const packs: TraePack[] = [];
  let limit = 0;
  let used = 0;

  list.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const base = pick(raw, 'entitlement_base_info', 'entitlementBaseInfo') ?? raw;
    const quota = isRecord(base) ? pick(base, 'quota') : undefined;
    const usage = pick(raw, 'usage') ?? {};
    const packLimit = firstNumber(
      isRecord(quota) ? pick(quota, 'credits_limit', 'creditsLimit') : undefined,
    );
    const packUsed = firstNumber(isRecord(usage) ? pick(usage, 'credits_amount', 'creditsAmount') : undefined);

    // credits_limit 缺失说明这是「功能权益」而非余额包，直接跳过；
    // 零额度且零消耗的包同样不参与统计（与 token-monitor 的判定保持一致）。
    if (packLimit === null || packLimit <= 0) return;
    const consumed = packUsed === null ? 0 : Math.max(0, packUsed);
    if (consumed === 0 && packLimit === 0) return;

    const remaining = Math.max(0, packLimit - consumed);
    const label =
      firstString(
        isRecord(base) ? pick(base, 'product_name', 'productName', 'name', 'title') : undefined,
        isRecord(quota) ? pick(quota, 'name', 'title') : undefined,
      ) || `权益包 #${index + 1}`;

    packs.push({
      index,
      limit: packLimit,
      used: consumed,
      remaining,
      expiresAt: extractExpiry(raw) ?? extractExpiry(base ?? {}),
      label,
    });
    limit += packLimit;
    used += consumed;
  });

  if (packs.length === 0) throw new Error('响应中没有可用的权益包（可能套餐已耗尽或结构变更）');
  return { packs, limit, used, remaining: Math.max(0, limit - used) };
}

export const traeAdapter: ProviderAdapter = {
  id: 'trae',
  displayName: 'Trae',
  region: 'cn',
  dashboardUrl: 'https://www.trae.cn/ide/account',
  requiredCredentialKeys: ['accessToken'],
  credentialHint:
    '登录 trae.cn 后，从 DevTools 复制请求头 Authorization 中的 Cloud-IDE-JWT 值，' +
    '填入 credentials.accessToken（可含 "Cloud-IDE-JWT " 前缀，会被自动剥离）。',
  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    const rawToken = cred(account, ctx, ['accessToken', 'token', 'authorization']);
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!rawToken) return notConfigured(traeAdapter, account, ctx, ['accessToken']);

    const accessToken = rawToken
      .replace(/^authorization\s*:\s*/i, '')
      .replace(/^cloud-ide-jwt\s+/i, '')
      .trim();
    if (!accessToken || /[\r\n]/.test(accessToken)) {
      return failure(traeAdapter, account, ctx, 'notConfigured', 'accessToken 含非法字符或为空');
    }

    const deviceId = cred(account, ctx, ['deviceId'], ['deviceId']);
    const origin = optString(account, 'origin') || TRAE_API_ORIGIN;

    try {
      const { body } = await fetchJson(traeEntUsageUrl(origin), {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${accessToken}`,
          'X-User-Region': 'CN',
          ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: '{}',
        timeoutMs: ctx.timeoutMs || TRAE_TIMEOUT_FALLBACK,
      });

      const parsed = parseTraeEntUsage(body);
      const lots: CreditLot[] = parsed.packs.map((pack) =>
        makeLot({
          id: `pack-${pack.index}`,
          label: pack.label,
          amount: pack.remaining,
          currency: 'CREDITS',
          expiresAt: pack.expiresAt,
          note: `原始额度 ${pack.limit}，已用 ${pack.used}${pack.expiresAt ? '' : '（该包未返回过期时间）'}`,
        }),
      );

      const earliestExpiry = parsed.packs
        .map((pack) => pack.expiresAt)
        .filter((value): value is string => typeof value === 'string')
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

      const window = makeWindow({
        kind: 'billing',
        label: 'Credits（全部权益包合计）',
        used: parsed.used,
        limit: parsed.limit,
        remaining: parsed.remaining,
        boundary: earliestExpiry ? 'expiry' : 'mixed',
        expiresAt: earliestExpiry,
      });

      return buildSnapshot({
        adapter: traeAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: parsed.remaining, currency: 'CREDITS' },
        credits: lots,
        windows: [window],
        note:
          parsed.packs.filter((pack) => pack.expiresAt).length === 0
            ? '接口未返回过期时间，建议以官方页面的「有效期」为准'
            : null,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(traeAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
