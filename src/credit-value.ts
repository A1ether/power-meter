/**
 * 各平台积分的「人民币估值」——「到期时间线」行内那几个 `≈ ¥X` 就来自这里。
 *
 * 两个口径，都写进悬停说明，界面主数字用官方口径：
 *
 *  - 官方口径（真金白银）：平台自己卖的「积分包 / 增购积分」单价。无假设，可上官网核对。
 *  - DeepSeek 基准：用户要求的口径 —— 假设这些积分全部用在 DeepSeek V4.1 Flash 上，
 *    这批用量「若直接接 DeepSeek 官方 API 要花多少钱」。算法 = 官方金额 × 比值，
 *    比值 = DeepSeek 官方单价 ÷ 平台该模型的 token 单价
 *    （同一模型两边单价一致时，输入/输出配比会自动消掉，不需要猜用量结构）。
 *
 * 只有平台公布了「该模型的 token 单价」时才敢算基准口径：Trae 公布了（企业版计费项），
 * Qoder / CodeArts 只公布模型间的相对系数（0.1× / 0.18），没有「1× 基准 = 每千 token 多少积分」
 * 这一环，CodeBuddy 连系数都没有 —— 这些一律不算、也不编，悬停里写明缺哪一环。
 *
 * 调价、补系数、补新平台：只改下面的 USD_CNY / DEEPSEEK_FLASH / CREDIT_PEGS。
 *
 * 设计依据见 `docs/plans/到期时间线-credits折算人民币-开发设计方案.md`。
 */
import type { Currency } from './types.js';

/** 美元 → 人民币：仅用于把「美元计价」的平台价折成人民币（Qoder 国际站）。改这里即可换汇率。 */
export const USD_CNY = 7.1;

/**
 * DeepSeek V4.1 Flash 官方单价（元 / 百万 token）。
 * 取**空闲档**为基准：高峰档（北京时间周一至周五 09:00–12:00、14:00–18:00，不含法定节假日）
 * 是空闲档的 2 倍。官方定价页：https://api-docs.deepseek.com/quick_start/pricing
 */
export const DEEPSEEK_FLASH = {
  inputPerMTok: 1,
  outputPerMTok: 4,
  cacheHitPerMTok: 0.02,
  peakMultiple: 2,
  pricePage: 'https://api-docs.deepseek.com/quick_start/pricing',
} as const;

export interface CreditPeg {
  /** 官方口径：1 个积分值多少人民币 */
  cnyPerUnit: number;
  /** 官方单价出处（原文进悬停） */
  official: string;
  /**
   * DeepSeek 基准比值 = DeepSeek 官方单价 ÷ 平台该模型 token 单价。
   * `null` = 该平台没给出可换算的单价 / 系数，基准口径不显示。
   */
  flashRatio: number | null;
  /** 基准口径的说明（含套用的比值与出处，原文进悬停） */
  flash: string;
}

/** 平台积分的官方单价表（2026-10-25 查证，按「积分包 / 增购积分」口径）。 */
export const CREDIT_PEGS: ReadonlyArray<{
  provider: string;
  /** 同一平台不同站点单价不同（Qoder 国内站 / 国际站）时按站点取 */
  region?: 'cn' | 'global';
  peg: CreditPeg;
}> = [
  {
    provider: 'trae',
    peg: {
      cnyPerUnit: 50 / 1000,
      official: 'Trae CN 增购积分 ¥50 / 1,000 积分（docs.trae.cn 套餐与计费；会员套餐折合约 ¥0.0245/积分）',
      flashRatio: 0.5,
      flash:
        'Trae 公布该模型 token 单价 输入 ¥2 / 输出 ¥8 / 缓存命中 ¥0.04 每百万（docs.trae.cn 计费项·企业版），恰为 DeepSeek 官方空闲档的 2 倍 ⇒ 比值 0.5',
    },
  },
  {
    provider: 'codebuddy',
    peg: {
      cnyPerUnit: 50 / 1000,
      official: '腾讯 CodeBuddy 个人加量包 ¥50 / 1,000 积分（codebuddy.cn/docs/ide/Account/pricing）',
      flashRatio: null,
      flash: 'CodeBuddy 只说明「不同模型 Token 定价不同」，未公布 token 单价或模型系数，无法按 DeepSeek V4.1 Flash 基准折算',
    },
  },
  {
    provider: 'codearts',
    peg: {
      cnyPerUnit: 50 / 1000,
      official: '华为云 CodeArts 码道 个人 1,000 积分包 ¥50（codearts.huaweicloud.com/pricing.html）',
      flashRatio: null,
      flash:
        'CodeArts 公布「模型积分消耗系数」DeepSeek-V4.1-Flash = 0.18，但未公布 1× 基准对应每千 token 多少积分，无法按该模型基准折算',
    },
  },
  {
    provider: 'qoder',
    region: 'cn',
    peg: {
      cnyPerUnit: 59 / 2000,
      official: 'Qoder CN 专业版 ¥59 / 月含 2,000 Credits（docs.qoder.cn 计费说明；Pro+ ¥169/6,000、Ultra ¥559/20,000 折合约 ¥0.028/Credit）',
      flashRatio: null,
      flash: 'Qoder 公布 Credits 用量参考系数（DeepSeek-Flash 0.1×），但未公布 1× 基准对应多少 token，无法按该模型基准折算',
    },
  },
  {
    provider: 'qoder',
    region: 'global',
    peg: {
      cnyPerUnit: (20 / 1500) * USD_CNY,
      official: `Qoder 国际站 个人资源包 $20 / 1,500 Credits（docs.qoder.com/zh/account/pricing），按 1 USD = ¥${USD_CNY} 折算`,
      flashRatio: null,
      flash: 'Qoder 公布 Credits 用量参考系数（DeepSeek-Flash 0.1×），但未公布 1× 基准对应多少 token，无法按该模型基准折算',
    },
  },
  {
    provider: 'minimax',
    peg: {
      cnyPerUnit: 7 / 1000,
      official: 'MiniMax 积分包 ¥30 / 4,285 积分 ≈ ¥7 / 1,000 积分（platform.minimax.cn；国际站 1,000 Credits = $1）',
      flashRatio: null,
      flash: 'MiniMax 官方规则是「积分按各模型 API 刊例价折算」，平台不提供 DeepSeek V4.1 Flash，无法按该模型基准折算',
    },
  },
];

export interface CnyValue {
  /** 官方口径金额（元）——界面主数字 */
  cny: number;
  /** 官方口径出处 */
  basis: string;
  /** DeepSeek V4.1 Flash 基准金额（元），算不出为 null */
  altCny: number | null;
  /** 基准口径说明，算不出为 null */
  altBasis: string | null;
  /** 悬停用的多行口径说明 */
  note: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 单价展示：去掉多余的 0（¥0.05 / ¥0.0295 / ¥0.007） */
function unit(price: number): string {
  return `¥${Number(price.toFixed(4))}`;
}

export function findCreditPeg(
  provider: string,
  region?: 'cn' | 'global',
): CreditPeg | null {
  const scoped = region
    ? CREDIT_PEGS.find((entry) => entry.provider === provider && entry.region === region)
    : undefined;
  const fallback = scoped ?? CREDIT_PEGS.find((entry) => entry.provider === provider && !entry.region);
  return fallback?.peg ?? null;
}

/**
 * 把一条额度折算成人民币。返回 `null` 表示「不折算」——非 CREDITS 单位
 * （A1etherOpenAi 的 QUOTA / USD 只按原单位显示）、自建与示例平台（没有官方单价，不编数字）、
 * 以及非正数金额。
 */
export function cnyValueFor(input: {
  provider: string;
  region?: 'cn' | 'global';
  currency: Currency;
  amount: number;
}): CnyValue | null {
  if (input.currency !== 'CREDITS') return null;
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;

  const peg = findCreditPeg(input.provider, input.region);
  if (!peg) return null;

  const cny = round2(input.amount * peg.cnyPerUnit);
  const altCny = peg.flashRatio === null ? null : round2(cny * peg.flashRatio);

  const lines = [
    `官方口径：${peg.official} ⇒ 约 ${unit(peg.cnyPerUnit)}/积分。`,
    altCny === null
      ? `DeepSeek V4.1 Flash 基准：${peg.flash}。`
      : `DeepSeek V4.1 Flash 基准：${peg.flash} ⇒ 这批额度若直接接 DeepSeek 官方约 ¥${altCny.toFixed(2)}（折合约 ${unit(cny === 0 ? 0 : (altCny ?? 0) / input.amount)}/积分）。`,
    `说明：官方单价按「积分包 / 增购积分」口径；基准比值同时适用于输入与输出，故与用量里输入输出的配比无关。DeepSeek 官方单价取空闲档（输入 ¥1 / 输出 ¥4 / 缓存命中 ¥0.02 每百万 token），高峰档为 2 倍。`,
  ];

  return {
    cny,
    basis: peg.official,
    altCny,
    altBasis: peg.flashRatio === null ? null : peg.flash,
    note: lines.join('\n'),
  };
}