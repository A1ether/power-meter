import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { clamp, firstNumber, firstString, getPath, isRecord, toIso } from '../lib/json.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, Currency, ProviderSnapshot, QuotaWindow, WindowKind } from '../types.js';
import {
  buildSnapshot,
  cred,
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
 * 可配置的「登录态 + JSON 字段映射」适配器。
 *
 * 思路借鉴 MeIotCOM/CodingPlanQuota 的 Custom / Relay（声明式 JSON 路径映射）
 * 与 Javis603/token-monitor 的 thirdparty provider：
 * 那些没有公开、稳定文档接口的平台（如 CodeBuddy / CodeArts），
 * 与其硬编码猜路径，不如让使用者把浏览器抓到的真实请求填进配置。
 */

export interface CreditLotMapping {
  /** 批次数组所在的 JSON 路径，如 data.packs */
  path: string;
  amount: string;
  expiresAt?: string;
  label?: string;
  currency?: Currency;
}

export interface WindowMapping {
  path: string;
  label?: string;
  used: string;
  limit: string;
  resetsAt?: string;
  expiresAt?: string;
  kind?: WindowKind;
}

export interface ApiMapping {
  /** 响应包裹路径，如 data.result；留空表示根 */
  wrap?: string;
  /** 余额：字符串表示路径，或对象形式并指定币种 */
  balance?: string | { path: string; currency?: Currency };
  creditLots?: CreditLotMapping;
  windows?: WindowMapping;
  plan?: string;
  /** 直接指定全局过期时间的路径（无批次时使用） */
  nextExpiry?: string;
}

export interface SessionApiPreset {
  id: string;
  displayName: string;
  region: 'cn' | 'global';
  dashboardUrl: string;
  /** 平台用量页地址（无则空串，见 base.ts 的 ProviderAdapter.usageUrl） */
  usageUrl: string;
  requiredCredentialKeys: string[];
  credentialHint: string;
  defaultEndpoint: string;
  defaultMethod: 'GET' | 'POST';
  defaultMapping: ApiMapping;
  /** 端点未配置时给用户的额外说明 */
  setupHint: string;
}

function mappingFromOptions(
  account: AccountConfig,
  preset: SessionApiPreset,
): ApiMapping {
  const raw = account.options.mapping;
  const custom = isRecord(raw) ? (raw as unknown as ApiMapping) : {};
  return {
    ...preset.defaultMapping,
    ...custom,
    balance: custom.balance ?? preset.defaultMapping.balance,
    creditLots: custom.creditLots ?? preset.defaultMapping.creditLots,
    windows: custom.windows ?? preset.defaultMapping.windows,
  };
}

function resolveWrap(body: unknown, wrap: string | undefined): unknown {
  if (!wrap) return body;
  const value = getPath(body, wrap);
  return value === undefined ? body : value;
}

export function createSessionApiAdapter(preset: SessionApiPreset): ProviderAdapter {
  const base: ProviderAdapter = {
    id: preset.id,
    displayName: preset.displayName,
    region: preset.region,
    dashboardUrl: preset.dashboardUrl,
    usageUrl: preset.usageUrl,
    requiredCredentialKeys: preset.requiredCredentialKeys,
    credentialHint: preset.credentialHint,
    probe: async (account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> => {
      const adapter: ProviderAdapter = {
        ...base,
        id: optString(account, 'providerId') || preset.id,
        displayName: optString(account, 'displayName') || preset.displayName,
      };

      const endpoint = optString(account, 'endpoint') || preset.defaultEndpoint;
      if (!endpoint) {
        return failure(
          adapter,
          account,
          ctx,
          'notConfigured',
          `${preset.displayName} 没有公开接口，需要你从浏览器抓一次真实请求后填入 options.endpoint。\n${preset.setupHint}`,
        );
      }

      const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
      const headerOption = account.options.headers;
      const extraHeaders = isRecord(headerOption)
        ? Object.fromEntries(
            Object.entries(headerOption)
              .filter(([, value]) => typeof value === 'string' && value !== '')
              .map(([key, value]) => [key, value as string]),
          )
        : {};

      // 平台要求的凭证不一定只有 Cookie：有的平台更适合放 Authorization / X-Auth-Token，
      // 只要提供了任一可用的鉴权材料，就不再判为「未配置」。
      const hasAlternativeAuth = Boolean(
        extraHeaders.Authorization ??
          extraHeaders.authorization ??
          extraHeaders['X-Auth-Token'] ??
          extraHeaders['x-auth-token'],
      );
      const missing = preset.requiredCredentialKeys.filter((key) => {
        if (account.credentials[key]) return false;
        if (key === 'cookie' && (cookie !== '' || hasAlternativeAuth)) return false;
        if (key === 'authorization' && hasAlternativeAuth) return false;
        return true;
      });
      if (missing.length > 0) return notConfigured(adapter, account, ctx, missing);

      const method = (optString(account, 'method') || preset.defaultMethod) as 'GET' | 'POST';
      const bodyOption = optString(account, 'body');
      const mapping = mappingFromOptions(account, preset);

      try {
        const { body } = await fetchJson(endpoint, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(optString(account, 'origin') ? { Origin: optString(account, 'origin') } : {}),
            ...(optString(account, 'referer') ? { Referer: optString(account, 'referer') } : {}),
            ...extraHeaders,
          },
          body: method === 'POST' ? bodyOption || '{}' : null,
          timeoutMs: ctx.timeoutMs,
        });

        if (account.options.assertBusinessOk !== false) assertBusinessOk(body);

        const payload = resolveWrap(body, mapping.wrap);
        const credits = extractLots(payload, mapping.creditLots, ctx);
        const windows = extractWindows(payload, mapping.windows);
        const balance = extractBalance(payload, mapping.balance);
        const plan = mapping.plan ? firstString(getPath(payload, mapping.plan)) : '';
        const explicitExpiry = mapping.nextExpiry
          ? toIso(getPath(payload, mapping.nextExpiry))
          : null;

        if (!balance && credits.length === 0 && windows.length === 0) {
          throw new Error(
            '字段映射没有解析出任何余额/积分，请核对 options.mapping 中的 JSON 路径。' +
              `响应顶层字段：${topLevelKeys(payload).join(', ') || '(空)'}`,
          );
        }

        const snapshot = buildSnapshot({
          adapter,
          account,
          status: 'ok',
          now: ctx.now,
          plan: plan || null,
          balance,
          credits,
          windows,
          note: explicitExpiry ? '过期时间取自 options.mapping.nextExpiry' : null,
        });
        if (!snapshot.nextExpiryAt && explicitExpiry) snapshot.nextExpiryAt = explicitExpiry;
        if (!snapshot.nextExpiryAt) {
          snapshot.note = snapshot.note ?? '未解析到过期时间，请在 mapping 中补充 creditLots.expiresAt';
        }
        return snapshot;
      } catch (error) {
        const status = error instanceof HttpError ? error.kind : 'error';
        return failure(adapter, account, ctx, status, (error as Error).message);
      }
    },
  };
  return base;
}

function topLevelKeys(payload: unknown): string[] {
  return isRecord(payload) ? Object.keys(payload).slice(0, 12) : [];
}

function extractLots(
  payload: unknown,
  mapping: CreditLotMapping | undefined,
  ctx: ProbeContext,
): CreditLot[] {
  if (!mapping) return [];
  const list = getPath(payload, mapping.path);
  if (!Array.isArray(list)) {
    ctx.log(`creditLots.path "${mapping.path}" 未命中数组，跳过积分批次解析`);
    return [];
  }
  const currency = mapping.currency ?? 'CREDITS';
  return list
    .map((item, index) => {
      const amount = firstNumber(getPath(item, mapping.amount));
      if (amount === null || amount <= 0) return null;
      const label =
        (mapping.label ? firstString(getPath(item, mapping.label)) : '') || `批次 #${index + 1}`;
      const expiresAt = mapping.expiresAt ? toIso(getPath(item, mapping.expiresAt)) : null;
      return makeLot({ id: `lot-${index}`, label, amount, currency, expiresAt });
    })
    .filter((lot): lot is CreditLot => lot !== null);
}

function extractWindows(payload: unknown, mapping: WindowMapping | undefined): QuotaWindow[] {
  if (!mapping) return [];
  const list = getPath(payload, mapping.path);
  if (!Array.isArray(list)) return [];
  const windows: QuotaWindow[] = [];
  list.forEach((item, index) => {
    const used = firstNumber(getPath(item, mapping.used)) ?? 0;
    const limit = firstNumber(getPath(item, mapping.limit));
    if (limit === null) return;
    const label = (mapping.label ? firstString(getPath(item, mapping.label)) : '') || `窗口 #${index + 1}`;
    const resetsAt = mapping.resetsAt ? toIso(getPath(item, mapping.resetsAt)) : null;
    const expiresAt = mapping.expiresAt ? toIso(getPath(item, mapping.expiresAt)) : null;
    windows.push(
      makeWindow({
        kind: mapping.kind ?? 'billing',
        label,
        used,
        limit,
        boundary: expiresAt ? 'expiry' : resetsAt ? 'reset' : 'mixed',
        resetsAt,
        expiresAt,
      }),
    );
  });
  return windows;
}

function extractBalance(
  payload: unknown,
  mapping: ApiMapping['balance'],
): { amount: number; currency: Currency } | null {
  if (!mapping) return null;
  const path = typeof mapping === 'string' ? mapping : mapping.path;
  const currency: Currency = typeof mapping === 'string' ? 'CREDITS' : mapping.currency ?? 'CREDITS';
  const amount = firstNumber(getPath(payload, path));
  if (amount === null) return null;
  return { amount: clamp(amount, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY), currency };
}
