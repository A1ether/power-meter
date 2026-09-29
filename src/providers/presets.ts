import { createSessionApiAdapter, type SessionApiPreset } from './sessionApi.js';
import type { ProviderAdapter } from './base.js';

/**
 * CodeBuddy（codebuddy.cn / copilot.tencent.com）
 *
 * 调研结论：截至 2026-09，GitHub 上没有任何开源项目实现了 CodeBuddy 的余额接口
 * （CodexBar 的 60+ provider、token-monitor 的 40+ provider 均未覆盖）。
 * 已实测 its API 网关返回 {"error_msg":"404 Route Not Found"}，说明是自研 JSON 网关，
 * 但具体路径需要登录后从浏览器抓取。因此这里用声明式映射，避免硬编码猜测。
 */
const CODEBUDDY_SETUP_HINT = [
  '抓取步骤：',
  '  1. 登录 https://www.codebuddy.cn ，打开 DevTools -> Network，筛选 Fetch/XHR；',
  '  2. 进入「账户 / 用量 / 积分」页面，找到返回余额或积分列表的那条请求；',
  '  3. 右键 -> Copy as cURL，把 URL 与 Cookie 填进配置，并把响应 JSON 的字段路径写进 options.mapping。',
].join('\n');

export const codebuddyPreset: SessionApiPreset = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  region: 'cn',
  dashboardUrl: 'https://www.codebuddy.cn',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '需要登录态 Cookie。可在 DevTools 里复制请求的 Cookie 头，并写入 credentials.cookie。',
  defaultEndpoint: '',
  defaultMethod: 'GET',
  defaultMapping: {
    wrap: 'data',
    balance: { path: 'balance|credits|totalCredits', currency: 'CREDITS' },
    creditLots: {
      path: 'creditPackages|packs|items',
      amount: 'remaining|remain|amount|leftCredits',
      expiresAt: 'expireTime|expiresAt|expire_at|endTime|validUntil',
      label: 'name|title|packageName|planName',
      currency: 'CREDITS',
    },
    plan: 'planName|plan|productName',
  },
  setupHint: CODEBUDDY_SETUP_HINT,
};

/**
 * CodeArts（codearts.huaweicloud.com，华为云）
 *
 * 调研结论：同样没有开源实现。华为云官方提供的是 AK/SK 签名的 API 网关
 * （codearts.<region>.myhuaweicloud.com），与网页版看板使用的登录态接口不是一套。
 * 这里优先支持「网页登录态 + 字段映射」；若你使用 AK/SK，
 * 可通过 options.headers 注入签名头，或在 preset 基础上扩展适配器。
 */
const CODEARTS_SETUP_HINT = [
  '抓取步骤：',
  '  1. 登录 https://codearts.huaweicloud.com ，打开 DevTools -> Network；',
  '  2. 进入费用 / 资源用量页，找到返回余额或配额清单的请求（通常带 X-Auth-Token 头）；',
  '  3. 把 URL、Cookie（或 options.headers 里的 X-Auth-Token）与响应字段路径填进配置。',
].join('\n');

export const codeartsPreset: SessionApiPreset = {
  id: 'codearts',
  displayName: 'CodeArts 华为云',
  region: 'cn',
  dashboardUrl: 'https://codearts.huaweicloud.com',
  requiredCredentialKeys: ['cookie'],
  credentialHint:
    '需要华为云控制台登录态。可填 credentials.cookie，或在 options.headers 里放 X-Auth-Token。',
  defaultEndpoint: '',
  defaultMethod: 'GET',
  defaultMapping: {
    wrap: 'data',
    balance: { path: 'balance|amount|availableAmount', currency: 'CNY' },
    creditLots: {
      path: 'resources|packages|items|quotaList',
      amount: 'remaining|remain|available|left',
      expiresAt: 'expireTime|expiresAt|expireAt|validUntil|endTime',
      label: 'name|resourceName|productName',
      currency: 'CNY',
    },
    plan: 'planName|plan|edition',
  },
  setupHint: CODEARTS_SETUP_HINT,
};

/** 通用兜底：任何自建/小众平台都能用同一套映射接进来 */
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
  ].join('\n'),
};

export const sessionApiAdapters: ProviderAdapter[] = [
  createSessionApiAdapter(codebuddyPreset),
  createSessionApiAdapter(codeartsPreset),
  createSessionApiAdapter(customPreset),
];
