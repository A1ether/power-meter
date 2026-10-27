import { assertBusinessOk, fetchJson, HttpError } from '../lib/http.js';
import { firstNumber, firstString, isRecord, pick, toIso } from '../lib/json.js';
import { fetchAllPages, incompleteNote, type PagedResult } from '../lib/pagination.js';
import { localDateKey, localNoonOf, startOfDay, type UsageLedger, type UsageRecord } from '../usage-ledger.js';
import type { AccountConfig } from '../config.js';
import type { CreditLot, ProviderSnapshot } from '../types.js';
import {
  buildCodeArtsSnapshot,
  fetchCodeArtsSubscription,
  readCodeArtsAkSk,
} from './codearts-aksk.js';
import {
  buildSnapshot,
  cred,
  failure,
  hiddenLotsNote,
  joinNotes,
  makeLot,
  makeWindow,
  normalizeCookieHeader,
  notConfigured,
  optString,
  splitByExpiry,
  type ProbeContext,
  type ProviderAdapter,
  type ProviderLogin,
} from './base.js';
import { ensureDebugChrome, openCookieCollector, type CookieCollector } from '../lib/cdp.js';

/**
 * CodeArts 华为云（codearts.huaweicloud.com，码道代码智能体）
 *
 * 接口全部通过 npm run capture 抓包定位并实测。分两层：
 *
 * 【汇总层】
 *   ① GET /portal/rest/me                          → projectId / domainId / region
 *   ② GET /portal/snap-manager/v1/package/overview  → 账户级总额度与各桶剩余
 *   ③ POST /portal/rest/bss/v1/cloudservices/countdown-iam5 → 订阅到期时间
 *
 * 【逐笔明细层】—— 页面上「套餐及积分包 / 活动福利」里每一笔的来源
 *   ④ GET /portal/promptcenter/v1/ops/credit/overview          → 活动列表（含 campaignId）
 *   ⑤ GET /portal/promptcenter/v1/ops/credit/campaign/{id}     → 该活动下每一笔的独立到期时间
 *      benefits[]: { benefitId, claimedAmount, consumedAmount, expiredAmount,
 *                    claimedAt, expireAt, validDuration }
 *
 * 为什么需要 ④⑤：② 只给出聚合桶（basic 500 / bonus 8000），
 * 而「每日签到领1000积分 共4笔」各自有独立的 expireAt，
 * 只有 ④⑤ 才能还原出与官方页面一致的分笔列表。
 *
 * 必需请求头（实测踩坑）：
 *   x-requested-with: XMLHttpRequest、x-language: zh-cn
 *     —— 缺失会被网关当成前端路由，返回 SPA 的 HTML（HTTP 200 但不是 JSON）
 *   cftk: <值>  —— ②④⑤ 不强制，③ 必需；其值等于 Cookie `devclouddevuibjtcftk`，从 Cookie 推导
 */

const CA_BASE = 'https://codearts.huaweicloud.com';

/** 给 GET 路径追加时间戳参数（避免浏览器/网关缓存，与页面行为一致） */
function withStamp(path: string): string {
  return `${CA_BASE}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;
}

/**
 * 按天用量的诊断日志：明细与探测同 TTL（默认 5 分钟一轮），同样的结论反复打印会
 * 把真正有用的日志淹掉，因此**同一进程内只在结论变化时打印一次**。
 *
 * 为什么值得留痕：「余额在跌、今日用量却是 0」这类问题只能靠它区分
 * 「上游当天没出数」与「接口结构变了」，见 docs/fixes/用量明细-CodeArts今日用量恒为0-修复方案.md。
 */
let lastDailyUseNote = '';
function logDailyUse(ctx: ProbeContext, note: string): void {
  if (note === lastDailyUseNote) return;
  lastDailyUseNote = note;
  ctx.log(`CodeArts 按天用量：${note}`);
}

/** 控制台 portal 请求头（Cookie + cftk 推导；缺 x-requested-with 会被网关当路由、返回 HTML） */
export function consoleHeaders(account: AccountConfig, cookie: string): Record<string, string> {
  const cftk = optString(account, 'cftk') || cookieValue(cookie, CFTK_COOKIE_NAME);
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-language': 'zh-cn',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: `${CA_BASE}/portal/settings/personal-usage?locale=zh-cn`,
    ...(cftk ? { cftk } : {}),
  };
}

/**
 * ⑤ 单个活动下的全部逐笔（分页取全）。
 *
 * 为什么必须翻页：`campaign/{id}` 分页返回，不带参数只给**上游默认页**（实测 20 笔）。
 * 账号签到笔数超过一页时，缺的批次会被「账户级桶 − 逐笔合计」差额吞并成一条
 * 「活动奖励积分（未明细部分）」——见
 * docs/fixes/CodeArts-活动奖励逐笔分页截断-修复方案.md。
 *
 * 翻页本身交给 `fetchAllPages()`（公共不变式，见 `src/lib/pagination.ts`），
 * 这里只负责「分页参数名探测」：`page/size` → `pageNum/pageSize` → 不带参数（兜底）。
 * 末位兜底很关键：若上游拒绝未知查询参数（或命名全猜错），至少拿到默认页，
 * 不会因为「加了参数」把整块活动明细弄丢。
 */
async function fetchCampaignBenefitEntries(
  headers: Record<string, string>,
  campaign: CreditCampaign,
  timeoutMs: number,
  ctx: ProbeContext,
): Promise<{
  entries: CampaignBenefit[];
  enumerated: number;
  expected: number | null;
  complete: boolean;
  incompleteReason: string | null;
}> {
  const expectedFromList = campaign.claimCount > 0 ? campaign.claimCount : null;
  const attempts: Array<{ label: string; query: (page: number) => string; maxPages: number }> = [
    ...CAMPAIGN_PAGE_STYLES.map((style) => ({
      label: `${style.page}/${style.size}`,
      query: (page: number) => `?${style.page}=${page}&${style.size}=${CAMPAIGN_PAGE_SIZE}`,
      maxPages: MAX_CAMPAIGN_PAGES,
    })),
    { label: '默认页（无参数）', query: () => '', maxPages: 1 },
  ];

  let best: PagedResult<CampaignBenefit> | null = null;
  let firstError: Error | null = null;

  for (const attempt of attempts) {
    try {
      const result = await fetchAllPages<CampaignBenefit>({
        pageSize: CAMPAIGN_PAGE_SIZE,
        maxPages: attempt.maxPages,
        keyOf: (entry) => entry.benefitId,
        label: `活动 ${campaign.id}（${attempt.label}）`,
        fetchPage: async (page) => {
          const { body } = await fetchJson(
            withStamp(
              `/portal/promptcenter/v1/ops/credit/campaign/${campaign.id}${attempt.query(page)}`,
            ),
            { headers, timeoutMs: Math.min(timeoutMs, 8_000) },
          );
          assertBusinessOk(body);
          const parsed = parseCampaignBenefitEntries(body);
          return { items: parsed.entries, total: parsed.total };
        },
      });
      // 取全即止；否则留下「枚举最多」的那次（默认页兜底通常最少）
      if (result.complete) {
        return {
          entries: result.items,
          enumerated: result.items.length,
          expected: result.expected ?? expectedFromList,
          complete: true,
          incompleteReason: null,
        };
      }
      if (!best || result.items.length > best.items.length) best = result;
    } catch (error) {
      firstError = firstError ?? (error as Error);
      ctx.log(
        `CodeArts 活动 ${campaign.id} 按「${attempt.label}」取逐笔失败：${(error as Error).message}`,
      );
    }
  }

  // 三种方式都失败（连默认页都拿不到）：抛出去由上层降级，与加参数之前的行为一致
  if (!best) throw firstError ?? new Error(`活动 ${campaign.id} 逐笔明细获取失败`);

  const expected = best.expected ?? expectedFromList;
  // 活动列表自报的 claimCount 也作为完整性交叉校验：上游 total 缺失或被过滤时仍能发现缺额
  const complete = best.complete || (expected !== null && best.items.length >= expected);
  const reason = incompleteNote(best, '笔');
  ctx.log(
    `CodeArts 活动 ${campaign.id}（${campaign.title}）逐笔未取全：枚举 ${best.items.length} 笔` +
      `${expected !== null ? `，上游声称 ${expected} 笔` : '，上游未给 total'}` +
      `${reason ? `；${reason}` : ''}`,
  );
  return {
    entries: best.items,
    enumerated: best.items.length,
    expected,
    complete,
    incompleteReason: reason,
  };
}

/**
 * ④⑤ 活动福利逐笔（登录态口径）：
 * overview 拿活动列表 → campaign/{id} 分页拿每一笔的 claimedAt / expireAt。
 * 失败直接抛错，由调用方决定降级（纯 Cookie 路径退回聚合口径；
 * 混合模式由 AK/SK 兜底余额，只把活动批次降级）。
 */
async function fetchCampaignBenefits(
  headers: Record<string, string>,
  timeoutMs: number,
  ctx: ProbeContext,
): Promise<{
  lots: CreditLot[];
  benefitTotal: number;
  campaignCount: number;
  /** 逐笔未取全时的说明（供「未明细部分」调节项 note 引用）；取全时为 null */
  coverageNote: string | null;
}> {
  const lots: CreditLot[] = [];
  let benefitTotal = 0;
  let enumerated = 0;
  let expected = 0;
  let expectedKnown = true;
  let incomplete = 0;
  const listResponse = await fetchJson(withStamp('/portal/promptcenter/v1/ops/credit/overview'), {
    headers,
    timeoutMs,
  });
  // 重要：会话失效时该接口返回「HTTP 200 + 空响应」，不报 401。
  // 若当成「0 个活动」，就会把登录态过期误报成「当前没有进行中的活动」——
  // 这里必须先识别空响应并明确抛错，让上层给出「重新抓取登录态」的提示。
  if (!isRecord(listResponse.body)) {
    throw new Error(
      '控制台返回空响应（登录态已失效），请执行 npm run capture -- codearts 重新抓取',
    );
  }
  assertBusinessOk(listResponse.body);
  const campaigns = parseCampaignList(listResponse.body).slice(0, MAX_CAMPAIGNS);

  for (const campaign of campaigns) {
    const detail = await fetchCampaignBenefitEntries(headers, campaign, timeoutMs, ctx);
    enumerated += detail.enumerated;
    if (detail.expected !== null) expected += detail.expected;
    else expectedKnown = false;
    if (!detail.complete) incomplete += 1;
    for (const benefit of detail.entries) {
      // 已用尽/已过期批次（剩余 ≤ 0）不进列表：既不影响合计，也不该显示为可用额度
      if (benefit.amount <= 0) continue;
      benefitTotal += benefit.amount;
      lots.push(
        makeLot({
          id: `codearts-campaign-${campaign.id}-${benefit.benefitId}`,
          label: campaign.title,
          amount: benefit.amount,
          currency: 'CREDITS',
          expiresAt: benefit.expiresAt,
          note: [
            benefit.claimedAt ? `领取于 ${benefit.claimedAt.slice(0, 10)}` : '',
            benefit.validDuration ? `有效期 ${benefit.validDuration}` : '',
          ]
            .filter(Boolean)
            .join('，'),
        }),
      );
    }
  }
  ctx.log(
    `CodeArts 活动逐笔：活动 ${campaigns.length} 个，枚举 ${enumerated} 笔（有剩余 ${lots.length} 笔）` +
      `${expectedKnown ? `，上游声称 ${expected} 笔` : ''}，合计 ${benefitTotal} 积分` +
      (incomplete > 0 ? `（⚠️ ${incomplete} 个活动未取全，缺额并入「未明细部分」）` : ''),
  );
  const coverageNote =
    incomplete > 0
      ? `上游分页未取全：枚举 ${enumerated} 笔` +
        `${expectedKnown ? ` / 上游声称 ${expected} 笔` : ''}，涉及 ${incomplete} 个活动`
      : null;
  return { lots, benefitTotal, campaignCount: campaigns.length, coverageNote };
}
const CA_TIMEOUT_FALLBACK = 12_000;
const CFTK_COOKIE_NAME = 'devclouddevuibjtcftk';
const DEFAULT_RESOURCE_TYPE = 'hws.resource.type.codearts.snap';
/** 活动数量上限，避免异常账号拉出几百个请求 */
const MAX_CAMPAIGNS = 20;
/** ⑤ 明细分页一次取多少笔：取 100 让常见规模（数十笔）一页取全，避免逐笔翻页 */
const CAMPAIGN_PAGE_SIZE = 100;
/** ⑤ 单活动最多翻页数（防御上游忽略分页参数时的死循环） */
const MAX_CAMPAIGN_PAGES = 10;
/**
 * ⑤ 分页参数命名候选，按序尝试。
 * 首选 `page` / `size`：同属 promptcenter 服务的 `credit/admin/usage` 在仓库内已有
 * 抓包结论使用该命名（docs/plans/供应商卡片-用量与增量字段-开发设计方案.md:44）；
 * `pageNum` / `pageSize` 作兜底。**不知道命名时不能只看第一页** —— 上游默认页只有
 * 20 笔，会静默丢掉超出部分（见 docs/fixes/CodeArts-活动奖励逐笔分页截断-修复方案.md）。
 */
const CAMPAIGN_PAGE_STYLES = [
  { page: 'page', size: 'size' },
  { page: 'pageNum', size: 'pageSize' },
] as const;

/* ------------------------------------------------------------------ *
 * 「网页端登录」（kind: 'web'）：与 Qoder 同构的登录方法。
 * 服务端只做编排——拉起调试 Chrome 打开用量页，登录动作由人工在该窗口完成
 * （华为云账号级登录态长期有效，多数情况 SSO 静默完成）；我们只旁听浏览器
 * 真实发出的请求头抓 Cookie，再走登录会话层 probe 验证落库。
 * 设计：docs/plans/账号管理-CodeArts网页端增删账号-开发设计方案.md §10。
 * ------------------------------------------------------------------ */

/** 登录判据：会话级 Cookie 名（credentialHint 要求的同一凭证形态） */
const CA_SESSION_COOKIE_NAME = 'devclouddevuibjJ_SESSION_ID';
/** 打开的页面：与 tools/codearts-refresh.sh 的 LOGIN_URL 同址（触发 SSO 与 /portal/ 请求） */
const CA_LOGIN_URL = 'https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn';
/** 登录会话时长上限（对齐 Qoder 网页登录；华为云 MFA 登录耗时可控） */
const CA_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
/** 后台轮询间隔（对齐 Qoder） */
const CA_WEB_POLL_INTERVAL_MS = 2_000;
/** 页面空闲多久才允许自动刷新（避免重置用户正在填写的登录表单，Qoder 的教训） */
const CA_WEB_RELOAD_IDLE_MS = 20_000;
/** 两次自动刷新的最小间隔 */
const CA_WEB_RELOAD_MIN_INTERVAL_MS = 15_000;
/** 自动刷新次数上限 */
const CA_WEB_RELOAD_MAX = 2;

/** 从拼好的 Cookie 头里取某个 cookie 的值（华为云的 CSRF token 就放在 cookie 里） */
export function cookieValue(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() === name) return trimmed.slice(eq + 1).trim();
  }
  return '';
}

interface CreditPackage {
  amount: number;
  used: number;
  remain: number;
}

function readCreditPackage(source: unknown): CreditPackage | null {
  if (!isRecord(source)) return null;
  const amount = firstNumber(pick(source, 'package_credit_amount', 'packageCreditAmount'));
  const remain = firstNumber(pick(source, 'package_credit_remain', 'packageCreditRemain'));
  if (amount === null && remain === null) return null;
  return {
    amount: amount ?? 0,
    used: firstNumber(pick(source, 'package_credit_used', 'packageCreditUsed')) ?? 0,
    remain: remain ?? 0,
  };
}

export interface CodeArtsOverview {
  total: CreditPackage;
  basic: CreditPackage | null;
  bonus: CreditPackage | null;
  ondemand: CreditPackage | null;
  resourceId: string;
  expiringAmount: number;
}

export function parseCodeArtsOverview(body: unknown): CodeArtsOverview {
  const allRaw = pick(body, 'all_credit_package', 'allCreditPackage');
  const all = readCreditPackage(allRaw);
  if (!all) throw new Error('响应缺少 all_credit_package（Cookie 可能已失效）');

  const basicRaw = pick(body, 'basic_package', 'basicPackage');
  const resourceId = isRecord(basicRaw)
    ? firstString(pick(basicRaw, 'resource_id', 'resourceId'))
    : '';

  return {
    total: all,
    basic: readCreditPackage(basicRaw),
    bonus: readCreditPackage(pick(body, 'bonus_credit_package', 'bonusCreditPackage')),
    ondemand: readCreditPackage(pick(body, 'ondemand_credit_package', 'ondemandCreditPackage')),
    resourceId,
    // 临近过期的积分额度（在 all_credit_package 内部）
    expiringAmount:
      firstNumber(
        isRecord(allRaw) ? pick(allRaw, 'expiring_credit_amount', 'expiringCreditAmount') : undefined,
      ) ?? 0,
  };
}

export interface CreditCampaign {
  id: number;
  title: string;
  claimCount: number;
  claimed: number;
  consumed: number;
}

export interface CampaignBenefit {
  benefitId: string;
  /** 仍有剩余的额度 = claimed − consumed − expired（可能 ≤ 0，表示已用尽/已过期） */
  amount: number;
  /** 本次领取总量（用量明细的「获取」口径用这个，而不是剩余） */
  claimedAmount: number;
  expiresAt: string | null;
  claimedAt: string | null;
  validDuration: string;
}

/** ④ 活动列表 */
export function parseCampaignList(body: unknown): CreditCampaign[] {
  const data = pick(body, 'data');
  const items = isRecord(data) ? pick(data, 'items') : undefined;
  if (!Array.isArray(items)) return [];
  const campaigns: CreditCampaign[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const id = firstNumber(pick(raw, 'campaignId', 'campaign_id'));
    if (id === null) continue;
    campaigns.push({
      id,
      title: firstString(pick(raw, 'campaignTitle', 'campaign_title')) || `活动 ${id}`,
      claimCount: firstNumber(pick(raw, 'claimCount', 'claim_count')) ?? 0,
      claimed: firstNumber(pick(raw, 'totalClaimed', 'total_claimed')) ?? 0,
      consumed: firstNumber(pick(raw, 'totalConsumed', 'total_consumed')) ?? 0,
    });
  }
  return campaigns;
}

/**
 * ⑤ 单页响应 → 全部条目 + 上游声称的总笔数。
 *
 * **不过滤 `amount ≤ 0`**：翻页进度必须按「本页出现过的全部 benefitId」判定
 * （已用尽/已过期批次也要计入），否则遇到已用尽批次会被误判成「已到末页」。
 * 过滤交给调用方（批次列表要正的、用量明细要 claimedAmount）。
 */
export function parseCampaignBenefitEntries(body: unknown): {
  entries: CampaignBenefit[];
  total: number | null;
} {
  const data = pick(body, 'data');
  const benefits = isRecord(data) ? pick(data, 'benefits') : undefined;
  const total = isRecord(data)
    ? firstNumber(pick(data, 'total', 'totalCount', 'total_count'))
    : null;
  if (!Array.isArray(benefits)) return { entries: [], total };
  const entries: CampaignBenefit[] = [];
  for (const raw of benefits) {
    if (!isRecord(raw)) continue;
    const claimed = firstNumber(pick(raw, 'claimedAmount', 'claimed_amount')) ?? 0;
    const consumed = firstNumber(pick(raw, 'consumedAmount', 'consumed_amount')) ?? 0;
    const expired = firstNumber(pick(raw, 'expiredAmount', 'expired_amount')) ?? 0;
    entries.push({
      benefitId:
        firstString(pick(raw, 'benefitId', 'benefit_id')) || `${raw.length ?? entries.length}`,
      amount: claimed - consumed - expired,
      claimedAmount: claimed,
      expiresAt: toIso(pick(raw, 'expireAt', 'expire_at')),
      claimedAt: toIso(pick(raw, 'claimedAt', 'claimed_at')),
      validDuration: firstString(pick(raw, 'validDuration', 'valid_duration')),
    });
  }
  return { entries, total };
}

/** countdown 接口把详情塞在 JSON 字符串里 */
export function parseCountdownExpiry(body: unknown): string | null {
  const list = pick(body, 'cloudServiceCountDowns', 'cloudServiceCountdowns');
  if (!Array.isArray(list)) return null;
  const times: string[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const tipsRaw = pick(raw, 'countDownTips', 'countdownTips');
    let tips: unknown = tipsRaw;
    if (typeof tipsRaw === 'string') {
      try {
        tips = JSON.parse(tipsRaw);
      } catch {
        tips = null;
      }
    }
    const iso = isRecord(tips)
      ? toIso(pick(tips, 'expTime', 'exp_time') ?? pick(tips, 'effTime', 'eff_time'))
      : null;
    if (iso) times.push(iso);
  }
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[times.length - 1] ?? null;
}

/**
 * 「网页端登录」实现：与 Qoder 的 qoderWebLogin 同构（src/providers/qoder.ts）。
 *
 * 去重键刻意用**平台级常量 `'web'`** 而不是 Cookie 指纹：华为云每次登录都会换发
 * 会话 Cookie（Session ID 变化），指纹去重必然「重新登录 → 新建卡片」；调试 Chrome
 * 单 profile 同一时刻也只有一个华为云登录态，多账号本就应走 AK/SK 表单多槽位。
 * 固定 id 让重新登录命中 landLoginAccount 的 loginAccountId 去重（account-store.ts），
 * 原地更新同一条目并刷新 CODEARTS_COOKIE。
 *
 * 登录判据：codearts.huaweicloud.com 请求头里出现会话 Cookie 名（与 credentialHint
 * 要求的同一凭证形态）。匿名态误判由落库前的 probe 真实验证兜住——华为云失效会话
 * 返回「200 + 空响应」，probe 必然解析失败，报 failed 不写盘。
 */
const codeartsWebLogin: ProviderLogin = {
  id: 'web',
  kind: 'web',
  label: '网页端登录',
  hint:
    '自动打开调试 Chrome 的华为云用量页，登录后自动完成添加。首次登录建议让 Chrome 保存密码' +
    '（或用华为云 App 扫码 / Touch ID 通行密钥）——该窗口的配置持久保存，之后基本无需再输密码。',
  qr: false,
  intervalMs: CA_WEB_POLL_INTERVAL_MS,
  async start(input) {
    // ① 确保调试 Chrome 在跑（没跑则按 tools/chrome-debug.sh 同款参数拉起）
    const chrome = await ensureDebugChrome();
    input.log(
      `CodeArts 调试 Chrome 已就绪（${chrome.browser}${chrome.started ? '，本次已拉起' : '，复用已运行的实例'}）`,
    );

    // ② 打开用量页并旁听请求头；采集器挂在 secret 里，cleanup 时释放
    const collector = await openCookieCollector({ url: CA_LOGIN_URL });
    input.log('CodeArts 用量页已打开，等待登录（已有华为云账号登录态时通常静默完成）');

    return {
      authUrl: CA_LOGIN_URL,
      qr: false,
      ttlMs: CA_WEB_LOGIN_TTL_MS,
      hint: '请在刚打开的 Chrome 窗口里登录华为云：可让 Chrome 保存密码、用 App 扫码或 Touch ID 通行密钥（只需一次，之后自动填充 / SSO 静默续期）；登录后本页面会自动完成添加。',
      secret: { collector, startedAt: Date.now(), reloads: 0, lastReloadAt: 0 },
    };
  },
  async poll(secret) {
    if (!isRecord(secret)) return { status: 'failed', message: '登录会话缺少采集器参数，请重新发起。' };
    const collector = pick(secret, 'collector') as CookieCollector | undefined;
    const startedAt = Number(pick(secret, 'startedAt')) || Date.now();
    if (!collector || typeof collector.cookieFor !== 'function') {
      return { status: 'failed', message: '登录会话缺少采集器，请重新发起。' };
    }

    const hosts = ['codearts.huaweicloud.com'];
    const raw = collector.cookieFor(hosts);
    const names = collector.cookieNamesFor(hosts);
    const loggedIn = Boolean(raw) && names.includes(CA_SESSION_COOKIE_NAME);

    if (!loggedIn) {
      // 刷新策略与 Qoder 一致：只在页面确实空闲时刷新，限次 + 最小间隔，
      // 避免重置用户正在填写的登录表单。
      const reloads = Number(pick(secret, 'reloads')) || 0;
      const lastReloadAt = Number(pick(secret, 'lastReloadAt')) || 0;
      const now = Date.now();
      const idle = collector.idleMs();
      const idleLongEnough = idle >= CA_WEB_RELOAD_IDLE_MS || idle === 0;
      if (
        reloads < CA_WEB_RELOAD_MAX &&
        idleLongEnough &&
        now - lastReloadAt >= CA_WEB_RELOAD_MIN_INTERVAL_MS
      ) {
        await collector.reload();
        if (isRecord(secret)) {
          secret.reloads = reloads + 1;
          secret.lastReloadAt = now;
        }
      }
      const waitedSec = Math.round((now - startedAt) / 1000);
      return {
        status: 'waiting',
        message: raw
          ? `已抓到华为云页面的 Cookie，但尚未检测到登录态，请在该 Chrome 窗口完成登录（已等待 ${waitedSec} 秒）…`
          : `正在等待你在调试 Chrome 窗口里登录华为云（已等待 ${waitedSec} 秒）…`,
      };
    }

    const cookie = normalizeCookieHeader(raw ?? '') ?? '';
    if (!cookie) return { status: 'waiting', message: '抓到的 Cookie 头为空，继续等待页面发起新请求…' };

    // 昵称：/portal/rest/me 的 name/projectName 字段可得则用之（取证前允许为空，
    // 落库层回退占位名「平台 · 登录账号」；isPlaceholderLoginName 支持日后补改名）
    const name = await codeartsCookieIdentity(cookie);

    return {
      status: 'ready',
      account: { id: 'web', name },
      credentials: { cookie },
      options: {},
      message: '已抓到登录 Cookie，正在验证取数并写入本机配置…',
    };
  },
  async cleanup(secret) {
    // 释放我们开出的标签页与 WebSocket；浏览器本体不关（用户可能还在用）
    const collector = isRecord(secret)
      ? (pick(secret, 'collector') as CookieCollector | undefined)
      : undefined;
    await collector?.close().catch(() => {});
  },
};

/** 从 /portal/rest/me 提取显示名（取不到返回空串，落库层用占位名） */
async function codeartsCookieIdentity(cookie: string): Promise<string> {
  try {
    const { body } = await fetchJson(`${CA_BASE}/portal/rest/me`, {
      headers: consoleHeaders(SHELL_ACCOUNT_FOR_IDENTITY, cookie),
      timeoutMs: 8_000,
    });
    if (!isRecord(body)) return '';
    return firstString(pick(body, 'name', 'userName', 'projectName')) ?? '';
  } catch {
    // 身份接口失败不阻断登录（去重不依赖它）
    return '';
  }
}

/** consoleHeaders 只用 options.cftk（Cookie 里推导），这里给一个最小账号壳 */
const SHELL_ACCOUNT_FOR_IDENTITY: AccountConfig = {
  provider: 'codearts',
  enabled: true,
  displayName: null,
  credentials: {},
  options: {},
};

export const codeartsAdapter: ProviderAdapter = {
  id: 'codearts',
  displayName: 'CodeArts 华为云',
  region: 'cn',
  dashboardUrl: 'https://codearts.huaweicloud.com/portal/settings/personal-usage',
  usageUrl: 'https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn',
  requiredCredentialKeys: ['cookie'],
  /**
   * AK/SK 或 Cookie 任一齐全即可取数（`requiredCredentialKeys` 表达不了「A 或 B」）。
   * AK/SK 的全局兜底（.env 的 CODEARTS_AK/SK）同样算已配置——老用户是不写 accounts.json 的。
   */
  isConfigured: (account) =>
    Boolean(readCodeArtsAkSk(account)) ||
    Boolean(account.credentials.cookie || account.credentials.cookieHeader) ||
    Boolean(process.env.CODEARTS_AK || process.env.CODEARTS_CLI_AK),
  credentialHint:
    '三种凭证方式任选其一：① 推荐「网页端登录」——卡片上点按钮自动打开华为云用量页，' +
    '登录后自动完成添加（Cookie 自动落 CODEARTS_COOKIE，配合 npm run codearts:refresh 定时续期）；' +
    '② AK/SK（credentials.accessKey/secretKey，或 .env 的 CODEARTS_AK/CODEARTS_SK）——走 snap-access ' +
    '网关、长期有效，适合多账号；③ 兼容旧方式：登录 codearts.huaweicloud.com 后复制 Cookie（需含 ' +
    'devclouddevuibjJ_SESSION_ID 与 devclouddevuibjtcftk，可用 npm run capture 抓取），会话过期后需重新抓取。',
  /**
   * 「网页端登录」：点按钮 → 调试 Chrome 自动打开华为云用量页 → 人工在该窗口登录
   * （账号级登录态长期有效，多数情况 SSO 静默完成）→ CDP 旁听请求头自动抓 Cookie →
   * 登录会话层 probe 验证落库（写入 CODEARTS_COOKIE，与 codearts:refresh 工具链同名）。
   * 服务端只做编排，不含任何自动登录动作（代填账密/过验证码的风控红线维持不变，
   * 见 docs/fixes/CodeArts-华为云登录态频繁失效-修复方案.md §3.1 选项 C/E）。
   */
  login: codeartsWebLogin,
  /**
   * 增删账号走通用实现（src/account-store.ts），表单字段见 manageFields。
   *
   * AK/SK 表单是兜底与多账号路径（长期有效，不会像登录态那样一小时就失效）；
   * Cookie 是可选附加项——填了就能把活动福利展开成逐笔明细（见 probe 的混合增强），
   * 不填则退回聚合口径，余额仍由 AK/SK 权威给出。
   */
  manageAccounts: true,
  manageFields: [
    {
      key: 'accessKey',
      label: 'AccessKey',
      placeholder: '华为云控制台 → 我的凭证 → 访问密钥 → Access Key Id（AK）',
      hint: '长期有效。IAM 账号需具备费用中心查看权限（billing:resourcePackages:view）。',
      secret: false,
    },
    {
      key: 'secretKey',
      label: 'SecretKey',
      placeholder: '与 AccessKey 配对的 Secret Access Key（SK）',
      hint: '与 AccessKey 成对保存；写入 .env 后页面不再回显。',
      pairedWith: 'accessKey',
    },
    {
      key: 'cookie',
      label: 'Cookie（可选）',
      placeholder: '登录 codearts.huaweicloud.com → DevTools → 任意 /portal/ 请求 → 复制 Cookie 整段值',
      hint: '填了会把活动福利展开成逐笔明细；登录态约一小时过期，过期只影响活动明细，不影响余额。',
      required: false,
      multiline: true,
    },
  ],
  manageHint:
    '会用这组 AK/SK 真实调用一次华为云 snap-access 网关（签名验证），通过后才写入本机 .env 新槽位与 accounts.json；写入前自动备份到 .run/。' +
    '提示：若已有「网页端登录」添加的账号且未单独配置 AK/SK，本机 .env 的 CODEARTS_AK/SK 全局兜底会与它同时生效，' +
    '卡片可能重复计余额——二选一即可（删除网页登录账号，或清空全局 CODEARTS_AK/SK 并给该账号补 AK/SK）。',
  /**
   * 用量 + 获取明细（v2）：
   *   - 用量：按天图表（`xDimension=DATE_DAY` + `TOTAL_CREDITS`，取昨日/今日两天），
   *     与页面「使用明细」同一数据源，缺天视为 0；
   *   - 获取：活动福利逐笔（`credit/overview` + `campaign/{id}` 的 claimedAmount/claimedAt），
   *     即页面「获取明细」页签的数据源。
   */
  async fetchUsageLedger(account: AccountConfig, ctx: ProbeContext): Promise<UsageLedger | null> {
    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) return null;
    const timeoutMs = ctx.timeoutMs || CA_TIMEOUT_FALLBACK;
    const cftk = optString(account, 'cftk') || cookieValue(cookie, CFTK_COOKIE_NAME);
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-language': 'zh-cn',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${CA_BASE}/portal/settings/personal-usage?locale=zh-cn`,
      ...(cftk ? { cftk } : {}),
    };
    const records: UsageRecord[] = [];

    // ① 用量：按天图表
    let useCovered = false;
    try {
      const { body } = await fetchJson(
        withStamp('/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            startDate: localDateKey(startOfDay(ctx.now) - 86_400_000),
            endDate: localDateKey(ctx.now),
            metrics: ['TOTAL_CREDITS'],
            xDimension: 'DATE_DAY',
          }),
          timeoutMs,
        },
      );
      if (!isRecord(body)) {
        logDailyUse(ctx, '控制台按天用量返回空响应（登录态可能已失效），退回本地采样');
      }
      const data = pick(body, 'data');
      const series = isRecord(data) ? pick(data, 'series') : undefined;
      const creditsSeries = Array.isArray(series)
        ? series.find((item) => isRecord(item) && /credit/i.test(String(pick(item, 'name') ?? '')))
        : undefined;
      const cells = isRecord(creditsSeries) ? pick(creditsSeries, 'cells') : undefined;
      if (!Array.isArray(cells) || cells.length === 0) {
        // 找不到积分序列（或没有格子）：接口结构可能已变 —— 必须*不*声明覆盖，
        // 否则「今天/昨天没有记录」会被上游口径补成确定的 0（余额在跌却显示 0）
        logDailyUse(ctx, '按天用量里没有可用的积分格子（接口结构可能已变），退回本地采样');
      } else {
        let unparsed = 0;
        let todayCells = 0;
        const todayStart = startOfDay(ctx.now);
        for (const cell of cells) {
          if (!isRecord(cell)) {
            unparsed += 1;
            continue;
          }
          const at = localNoonOf(String(pick(cell, 'xLabel', 'x_label') ?? ''));
          const amount = firstNumber(pick(cell, 'value'));
          // 解析不出的格子既不能当 0、也不能当覆盖依据；解析得出的 0 是有效值（当天确实没消耗）
          if (at === null || amount === null) {
            unparsed += 1;
            continue;
          }
          if (at >= todayStart) todayCells += 1;
          if (amount <= 0) continue;
          records.push({ at, kind: 'use', amount });
        }
        if (unparsed === cells.length) {
          logDailyUse(
            ctx,
            `按天用量 ${cells.length} 格全部无法解析（xLabel 结构可能已变），退回本地采样`,
          );
        } else {
          useCovered = true;
          // 上游按天聚合当天可能尚未出数：不在这里纠偏（编排层会用本地观测兜底），
          // 但要留痕，便于把「今日用量为什么来自本地观测」对上时间点
          if (todayCells === 0) {
            logDailyUse(ctx, '按天用量没有「今天」这一格（上游当天未出数），今日用量交给本地观测兜底');
          }
        }
      }
    } catch (error) {
      ctx.log(`CodeArts 按天用量获取失败（退回本地采样）：${(error as Error).message}`);
    }

    // ② 获取：活动福利逐笔（与页面「获取明细」页签同源）
    let grantCovered = false;
    try {
      const { body } = await fetchJson(withStamp('/portal/promptcenter/v1/ops/credit/overview'), {
        headers,
        timeoutMs,
      });
      assertBusinessOk(body);
      const campaigns = parseCampaignList(body).slice(0, MAX_CAMPAIGNS);
      if (campaigns.length === 0) {
        // 「活动列表为空」不等于「该日没有获取」：全新积分体系下活动记录可能不在此接口，
        // 若这里声明已覆盖，余额明明涨了 1000 也会被压成 0 —— 交给本地采样兜底。
        ctx.log('CodeArts 活动列表为空，获取明细降级为本地采样');
      } else {
        // 与批次列表共用同一条分页取全路径：漏页会让「获取」增量少算（历史缺陷同源）
        let grantIncomplete = 0;
        for (const campaign of campaigns) {
          const detail = await fetchCampaignBenefitEntries(headers, campaign, timeoutMs, ctx);
          if (!detail.complete) grantIncomplete += 1;
          for (const entry of detail.entries) {
            if (entry.claimedAmount <= 0) continue;
            const at = entry.claimedAt ? Date.parse(entry.claimedAt) : Number.NaN;
            if (!Number.isFinite(at)) continue;
            records.push({ at, kind: 'grant', amount: entry.claimedAmount });
          }
        }
        // 未取全时**不声明已覆盖**：宁可让本地采样兜底，也不把截断后的合适当成完整日增量
        grantCovered = grantIncomplete === 0;
        if (!grantCovered) {
          ctx.log(`CodeArts 获取明细有 ${grantIncomplete} 个活动未取全，该维度退回本地采样`);
        }
      }
    } catch (error) {
      ctx.log(`CodeArts 获取明细获取失败（退回本地采样）：${(error as Error).message}`);
    }

    return { records, covers: { use: useCovered, grant: grantCovered } };
  },

  async probe(account: AccountConfig, ctx: ProbeContext): Promise<ProviderSnapshot> {
    // 凭证优先级：AK/SK（长期有效，走 snap-access 网关）→ 控制台 Cookie（会话过期需重抓）
    // options.authMode: 'auto'（默认）| 'aksk'（只用 AK/SK）| 'cookie'（只用登录态）
    const authMode = (optString(account, 'authMode') || 'auto').toLowerCase();
    const aksk = authMode === 'cookie' ? null : readCodeArtsAkSk(account, ctx);
    if (aksk) {
      const timeoutMs = ctx.timeoutMs || CA_TIMEOUT_FALLBACK;
      // auto 模式下登录态是否可用决定要不要做活动逐笔（混合增强）；
      // 没有 Cookie 就不存在「回退登录态」这一步，AK/SK 成败即最终结果——
      // 否则纯 AK/SK 账号会掉到下面的 notConfigured，看板添加账号的预校验也会误判。
      const cookie = authMode === 'aksk' ? '' : normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
      try {
        const subscription = await fetchCodeArtsSubscription(aksk, timeoutMs);
        if (!cookie) {
          return buildCodeArtsSnapshot(
            codeartsAdapter,
            account,
            ctx,
            subscription,
            null,
            authMode === 'aksk' ? null : '未配置登录态 Cookie，活动福利按聚合口径展示',
          );
        }

        // auto（混合增强）：余额/额度窗口用 AK/SK 的权威口径；登录态可用时，
        // 活动福利批次改用控制台逐笔明细（每笔独立到期），明细缺失只降级活动批次。
        try {
          const detail = await fetchCampaignBenefits(consoleHeaders(account, cookie), timeoutMs, ctx);
          if (detail.lots.length === 0) {
            const reason =
              detail.campaignCount === 0
                ? '登录态可用，但活动列表为空（当前没有进行中的活动），活动福利按聚合口径展示'
                : `活动列表有 ${detail.campaignCount} 个但无剩余逐笔，活动福利按聚合口径展示`;
            return buildCodeArtsSnapshot(codeartsAdapter, account, ctx, subscription, null, reason);
          }
          return buildCodeArtsSnapshot(codeartsAdapter, account, ctx, subscription, detail);
        } catch (error) {
          const detailNote = `活动逐笔明细获取失败（登录态可能已失效），活动福利退回聚合口径：${(error as Error).message}`;
          ctx.log(`CodeArts ${detailNote}`);
          return buildCodeArtsSnapshot(codeartsAdapter, account, ctx, subscription, null, detailNote);
        }
      } catch (error) {
        const message = (error as Error).message;
        if (authMode === 'aksk' || !cookie) {
          return failure(
            codeartsAdapter,
            account,
            ctx,
            error instanceof HttpError ? error.kind : 'error',
            `AK/SK 取数失败：${message}`,
          );
        }
        ctx.log(`CodeArts AK/SK 取数失败，回退登录态口径：${message}`);
      }
    }

    const cookie = normalizeCookieHeader(cred(account, ctx, ['cookie', 'cookieHeader']));
    if (!cookie) {
      // 走到这里说明没有可用的 AK/SK（配齐了上面就会返回）也没有 Cookie。
      return notConfigured(
        {
          ...codeartsAdapter,
          credentialHint: '若用 AK/SK，accessKey 与 secretKey 必须成对填写；只填一个会被忽略。',
        },
        account,
        ctx,
        ['AK/SK（accessKey + secretKey）或 Cookie'],
      );
    }

    const timeoutMs = ctx.timeoutMs || CA_TIMEOUT_FALLBACK;
    const headers = consoleHeaders(account, cookie);
    const stamp = (path: string): string => `${CA_BASE}${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;

    try {
      // ② 账户级汇总
      const overviewResponse = await fetchJson(stamp('/portal/snap-manager/v1/package/overview'), {
        headers,
        timeoutMs,
      });
      const overview = parseCodeArtsOverview(overviewResponse.body);

      // ③ 订阅到期时间
      let subscriptionExpiry: string | null = null;
      let tenantId = '';
      let regionId = optString(account, 'region') || 'cn-north-4';
      if (overview.resourceId) {
        try {
          const meResponse = await fetchJson(stamp('/portal/rest/me'), {
            headers,
            timeoutMs: Math.min(timeoutMs, 8_000),
          });
          const me = isRecord(meResponse.body) ? meResponse.body : {};
          tenantId = firstString(pick(me, 'projectId', 'project_id'));
          regionId = firstString(pick(me, 'region', 'regionId')) || regionId;

          const countdownResponse = await fetchJson(
            `${CA_BASE}/portal/rest/bss/v1/cloudservices/countdown-iam5`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                tenantId,
                cloudServiceType: 'hws.service.type.devcloud',
                resourceType: optString(account, 'resourceType') || DEFAULT_RESOURCE_TYPE,
                regionId,
                resourceIds: [overview.resourceId],
              }),
              timeoutMs: Math.min(timeoutMs, 8_000),
            },
          );
          subscriptionExpiry = parseCountdownExpiry(countdownResponse.body);
        } catch (error) {
          ctx.log(`CodeArts 订阅到期时间获取失败（不影响余额）：${(error as Error).message}`);
        }
      } else {
        ctx.log('CodeArts 未找到 resource_id，跳过订阅到期时间查询');
      }

      // ④⑤ 逐笔明细：把 bonus 桶展开成每笔活动奖励
      const lots: CreditLot[] = [];
      let campaignNote: string | null = null;
      let coverageNote: string | null = null;
      let benefitTotal = 0;

      try {
        const detail = await fetchCampaignBenefits(headers, timeoutMs, ctx);
        benefitTotal = detail.benefitTotal;
        coverageNote = detail.coverageNote;
        lots.push(...detail.lots);
      } catch (error) {
        campaignNote = `活动明细获取失败，已退回聚合口径：${(error as Error).message}`;
        ctx.log(campaignNote);
      }

      // ① 基础套餐（订阅自带额度）
      if (overview.basic && overview.basic.remain > 0) {
        lots.unshift(
          makeLot({
            id: 'codearts-basic',
            label: '个人订阅套餐',
            amount: overview.basic.remain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: `套餐额度 ${overview.basic.amount}，已用 ${overview.basic.used}`,
          }),
        );
      }
      // 活动奖励桶与账户级 bonus 对账：明细拉不到就退回聚合口径，差值补一条调节项。
      // 取全了逐笔（coverageNote 为 null）时这条 gap 通常为 0，自然不出现。
      const bonusRemain = Math.round((overview.bonus?.remain ?? 0) * 100) / 100;
      const withCoverage = (base: string): string =>
        coverageNote ? `${base}；${coverageNote}` : base;
      if (benefitTotal <= 0 && bonusRemain > 0) {
        lots.push(
          makeLot({
            id: 'codearts-bonus',
            label: '活动奖励积分（合计）',
            amount: bonusRemain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: withCoverage('活动明细不可用，已退回聚合额度'),
          }),
        );
      } else {
        const gap = Math.round((bonusRemain - benefitTotal) * 100) / 100;
        if (gap >= 1) {
          lots.push(
            makeLot({
              id: 'codearts-bonus-gap',
              label: '活动奖励积分（未明细部分）',
              amount: gap,
              currency: 'CREDITS',
              expiresAt: subscriptionExpiry,
              note: withCoverage(
                `活动明细合计 ${benefitTotal}，与聚合额度 ${bonusRemain} 的差额`,
              ),
            }),
          );
        }
      }

      // 按需积分包（如有）
      if (overview.ondemand && overview.ondemand.remain > 0) {
        lots.push(
          makeLot({
            id: 'codearts-ondemand',
            label: '按需积分包',
            amount: overview.ondemand.remain,
            currency: 'CREDITS',
            expiresAt: subscriptionExpiry,
            note: '按需计费额度',
          }),
        );
      }

      const { active, expired } = splitByExpiry(lots, ctx.now);

      const window = makeWindow({
        kind: 'billing',
        label: '积分额度（全部资源包）',
        used: overview.total.used,
        limit: overview.total.amount,
        remaining: overview.total.remain,
        boundary: subscriptionExpiry ? 'expiry' : 'mixed',
        expiresAt: subscriptionExpiry,
      });

      return buildSnapshot({
        adapter: codeartsAdapter,
        account,
        status: 'ok',
        now: ctx.now,
        balance: { amount: overview.total.remain, currency: 'CREDITS' },
        credits: active,
        windows: [window],
        note: joinNotes(
          hiddenLotsNote(expired),
          campaignNote,
          overview.expiringAmount > 0 ? `有 ${overview.expiringAmount} 积分临近过期` : null,
          !subscriptionExpiry ? '未取到订阅到期时间，可检查 cftk 是否随 Cookie 一并提供' : null,
        ),
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.kind : 'error';
      return failure(codeartsAdapter, account, ctx, status, (error as Error).message);
    }
  },
};
