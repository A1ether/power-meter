# Power Meter · 多平台 AI 余额看板

一个标签页看完所有 AI 平台账户的余额、积分和**过期日期**，并按"最快到期"排序 / 高亮，
避免在浏览器多标签之间反复切换。

- 运行时**零第三方依赖**（只用 Node 内置模块），`npm install` 只装 `tsx` / `typescript`
- 后端聚合 + 缓存 + 失败降级，前端纯静态（无构建步骤）
- 凭证**不下发到浏览器**，配置文件改动后**热加载**，无需重启

> 开发前的 GitHub 开源项目调研、复用评估与接口实测记录见
> [`docs/开源项目调研与复用评估.md`](docs/开源项目调研与复用评估.md)。
> **换成自己的账号（逐平台抓凭证 + 字段映射 + 排错）见
> [`docs/凭证配置指南.md`](docs/凭证配置指南.md)。**

---

## 快速开始

```bash
# 1. 安装（仅开发依赖，运行时零依赖）
npm install

# 2. 生成账号配置
cp accounts.example.json accounts.json

# 3. 启动
npm start
# 打开 http://127.0.0.1:8787
```

### 接入自己的账号（推荐：自动抓取，约 1 分钟）

```bash
npm run chrome:debug     # ① 弹出一个调试专用 Chrome 窗口
                         #   ② 在里面登录 Qoder / Trae / CodeBuddy / CodeArts
                         #      并各自打开「用量 / 账单」页面
npm run capture          # ③ 自动抓取四个平台的登录态，写入 .env
npm run probe            # ④ 验证取数是否正常
# 刷新 http://127.0.0.1:8787
```

四个平台都只需要**一个 Cookie**，其余全部自动完成 —— 包括 Trae 那个只有 1 天有效期的
JWT，由适配器用 Cookie 自动续签，不需要手工维护。

> 调试窗口用的是独立 profile（`~/.power-meter/chrome-profile`），与你日常的 Chrome 完全隔离。
> 原因：Chrome 136+ 禁止对默认资料目录开启远程调试端口。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动看板服务 |
| `npm run dev` | 带文件监听的热重载开发模式 |
| `npm run chrome:debug` | 启动带调试端口的独立 Chrome（抓取凭证用）|
| `npm run capture` | **自动抓取四个平台的登录态并写入 `.env`** |
| `npm run capture -- --dry-run` | 只预览，不写文件 |
| `npm run probe` | **命令行探测取数是否正常**（改配置后先跑这个最快）|
| `npm run probe -- qoder trae` | 只探测指定平台 |
| `npm run probe -- --json` | 输出机器可读结果 |
| `npm run typecheck` | 类型检查 |
| `npm run build && npm run serve` | 编译到 `dist/` 后以纯 JS 运行 |

手工配置（不用抓取工具）的完整步骤、各平台接口说明与排错表见
[`docs/凭证配置指南.md`](docs/凭证配置指南.md)。

`npm run probe` 的实测输出示例（真实账号）：

```
● Qoder              ok    252ms
                  余额 500 CREDITS  最快到期 2026-10-23
                    · 赠送资源包     100   过期 2026-10-29
                    · 赠送资源包     100   过期 2026-10-23
● Trae               ok    228ms
                  余额 3538.45 CREDITS  最快到期 2026-09-30
                  积分额度（本期）: 3538.45/4900
● CodeBuddy          ok    849ms
                  余额 2789.65 CREDITS  最快到期 2026-09-30
● CodeArts 华为云      ok   1129ms
                  余额 8500 CREDITS  最快到期 2026-10-26
                    · 基础套餐积分   500    过期 2026-10-26
                    · 赠送积分包    8000    过期 2026-10-26
合计 4 个平台，正常 4 个，异常 0 个。
```

---

## 项目结构

```
power-meter/
├── package.json                     # 运行时零依赖
├── tsconfig.json                    # ESM + NodeNext
├── .env.example                     # 环境变量模板
├── accounts.example.json            # 账号配置模板（复制为 accounts.json）
├── docs/
│   └── 开源项目调研与复用评估.md      # gh CLI 调研记录 + 复用方案 + 接口实测
├── public/                          # 前端（无构建步骤，直接被后端托管）
│   ├── index.html                   # 页面骨架 + <template> 卡片模板
│   ├── styles.css                   # 设计系统：明暗双主题、到期三色分级、脉冲高亮
│   └── app.js                       # 拉数、排序、筛选、倒计时渲染
└── src/
    ├── server.ts                    # HTTP 服务 + 路由 + 静态资源（Node 内置 http）
    ├── service.ts                   # 编排层：并发探测、TTL 缓存、失败回退、配置热加载
    ├── aggregate.ts                 # 聚合：汇总统计 + 到期时间线（最快到期排序）
    ├── config.ts                    # 配置加载：.env 解析、${VAR} 展开、mtime 监控
    ├── types.ts                     # 统一数据契约
    ├── cli/probe.ts                 # 命令行凭证探测工具
    ├── lib/
    │   ├── http.ts                  # 带硬超时的 fetch + HTTP/业务错误码映射
    │   ├── cache.ts                 # TTL + in-flight 去重 + last-good 兜底
    │   └── json.ts                  # 宽泛数字解析、JSON 路径取值、时间戳归一
    └── providers/                   # 平台适配器（新增平台只动这里）
        ├── base.ts                  # ProviderAdapter 契约 + 窗口/批次构建函数
        ├── index.ts                 # 注册表 + 平台别名解析
        ├── qoder.ts                 # qoder.com / qoder.com.cn / qoder.cn
        ├── trae.ts                  # trae.cn（权益包按过期时间拆批次）
        ├── sessionApi.ts            # 声明式"登录态 + JSON 映射"适配器工厂
        ├── presets.ts               # codebuddy / codearts / custom 预设
        └── demo.ts                  # 示例数据平台（demo:*）
```

---

## 关键实现思路

### 1. 统一数据契约：把异构平台压成同一张表

各平台的返回结构差异极大（Qoder 是 `quotaSummary.usedValue`，Trae 是 `user_entitlement_pack_list[]`，
自研网关五花八门）。核心是把它们归一为固定形状：

```ts
interface ProviderSnapshot {
  status: 'ok' | 'demo' | 'notConfigured' | 'unauthorized' | 'rateLimited' | 'unavailable' | ...;
  balance: { amount: number; currency: Currency } | null;
  windows: QuotaWindow[];   // 周期窗口：used / limit / remaining / 重置时间
  credits: CreditLot[];     // 积分批次：amount + expiresAt（本项目扩展）
  nextExpiryAt: string | null;   // 最快到期
  nextExpiryInDays: number | null;
}
```

`credits[]` 是"最快到期"能力的**最小单位**——一个平台可能有多个到期时间不同的批次
（Trae 的每个权益包、Qoder 的本期额度 + 赠送积分），必须拆开才能正确排序。

契约的字段命名与语义对齐了开源项目 `Javis603/token-monitor` 的
`normalizeLimitProvider`，便于后续跟进上游变化（详见调研文档）。

### 2. "最快到期"的三层实现

**第一层：适配器负责拆批次。** `trae.ts` 遍历 `user_entitlement_pack_list`，
每个可用权益包产出一个 `CreditLot`，并用 `extractExpiry()` 从
`expire_time / expiresAt / validUntil / endTime` 等 14 种命名里兼容抽取过期时间。

**第二层：聚合层生成全局时间线。** `aggregate.ts` 只保留**未来且有余额**的批次，
按 `expiresAt` 升序排列。这里有两个细节：

- 上游 `typesafe/limits.js` 的做法是只留未来批次，本项目沿用；
- 但 Qoder 只返回 `nextResetAt`（没有批次过期时间），如果只按批次过滤，
  Qoder 会掉出时间线——所以补了一条**合成事件**「本期额度重置（未用完即作废）」，
  金额取该平台积分合计。这让"重置即作废"的平台也能参与排序。

**第三层：前端分级高亮。** 阈值可配（默认 7 天 / 30 天）：

| 剩余时间 | 视觉表现 |
| --- | --- |
| ≤ 7 天 | 卡片顶部红条 + 状态点脉冲动画 + 批次左侧红边 + 顶部 danger 告警条 |
| 8~30 天 | 橙色边框 + 批次橙边 + warning 告警条 |
| > 30 天 | 绿色 |
| 无过期时间 | 灰色，排序恒排最后 |

同时 `prefers-reduced-motion` 下关闭脉冲动画。

### 3. 三种取数策略，覆盖"有接口"和"没接口"

| 策略 | 适用 | 实现 |
| --- | --- | --- |
| 内置适配器 | Qoder / Trae 等有稳定接口 | `qoder.ts` / `trae.ts`，含精确字段解析与错误语义 |
| 声明式映射 | CodeBuddy / CodeArts 等无公开接口 | `sessionApi.ts`：填 `endpoint` + `headers` + `mapping`（JSON 路径）即可接入 |
| 示例数据 | 首次运行预览界面 | `demo.ts`，确定性 fixture，界面上标注"示例数据" |

声明式映射的核心是 `mapping`：

```jsonc
{
  "wrap": "data",                                    // 响应包裹层
  "balance": { "path": "balance|credits", "currency": "CREDITS" },
  "creditLots": {                                    // 有它才有"最快到期"
    "path": "creditPackages|packs",                  // 批次数组路径
    "amount": "remaining|remain",                    // 用 | 表示候选字段
    "expiresAt": "expireTime|expiresAt|endTime",
    "label": "name|packageName"
  },
  "plan": "planName|plan"
}
```

路径解析支持 `a.b[0].c` 与 `a|b` 两种写法（`lib/json.ts` 的 `getPath`）。
解析不出来时，错误信息会**回显响应顶层字段名**，让你一眼看出该改哪条路径。

### 4. 可靠性与凭证安全

- **硬超时**：每平台请求用 `AbortSignal.timeout()` 独立限时（默认 12s），
  一个慢平台不会拖垮整个刷新。
- **并发上限**：默认 6 个平台并行（`service.ts` 的 worker 池）。
- **缓存与去重**：TTL 默认 300s（与上游项目一致），同一平台的并发刷新合并为一次上游请求；
  刷新失败的缓存只保留 15s，避免连续失败被放大。
- **失败降级**：上游报错时回退到上一次成功值并标记 `stale: true`，
  卡片显示"数据可能过期"黄标而不是变成空白。
- **配置热加载**：轮询 `accounts.json` 的 mtime，改完保存即生效。
- **凭证不外泄**：`/api/config` 只返回**存在哪些凭证 key**，不返回值；
  `accounts.json` 已加入 `.gitignore`，推荐用 `${ENV_VAR}` 引用 `.env`。

### 5. 前端零构建

用 `<template>` 克隆卡片、`textContent` 赋值（**不用 innerHTML 渲染上游数据**，
避免上游返回内容带来的注入风险）、`DocumentFragment` 批量插入。
排序 / 筛选 / 搜索全部在前端完成，切换即时响应，不触发网络请求。
配色走 `color-mix()` + CSS 变量，自动跟随系统明暗主题。

---

## 平台配置指南

### 通用规则

`accounts.json` 是一个数组（或 `{ "accounts": [...] }`）。每条：

```jsonc
{
  "provider": "qoder",              // 平台 id，支持别名，见下表
  "displayName": "Qoder",            // 可选，自定义展示名
  "enabled": true,
  "credentials": { "cookie": "${QODER_COOKIE}" },  // 敏感值，建议引用环境变量
  "options": { "site": "cn" }        // 非敏感配置
}
```

`credentials` / `options` 里任何字符串都支持 `${ENV_VAR}` 占位符；
缺失的环境变量会在界面「诊断」区和 `npm run probe` 里明确列出变量名。

### 各平台配置

四个平台的凭证都只需要 **一个 Cookie**：

| 平台 | `provider` | 需要的凭证 | 关键 `options` |
| --- | --- | --- | --- |
| Qoder | `qoder` / `qoder.cn` | `cookie` | `site: "cn"`（国内，默认）或 `"global"` |
| Trae | `trae` / `trae.cn` | `cookie` | JWT 由 Cookie 自动续签；可选 `accessToken` 覆盖 |
| CodeBuddy | `codebuddy` | `cookie`（**必须含 `www` 子域**）| — |
| CodeArts | `codearts` | `cookie`（含 `devclouddevuibjtcftk`）| 可选 `resourceType`、`region` |
| 任意平台 | `custom` | 按需 `headers` | `providerId`、`endpoint`、`mapping` |
| 示例数据 | `demo:qoder` / `demo:trae` / `demo:codebuddy` / `demo:codearts` / `demo:no-expiry` | 无 | — |

另有一个全局变量 `HTTP_USER_AGENT`：**CodeBuddy 的 WAF 会校验 UA**，
缺失或版本过旧会直接 401，`npm run capture` 会自动写入本机浏览器的真实 UA。

#### 取 Cookie / Token 的通用步骤

> 每个平台的**逐步操作说明、字段映射写法与排错表**见
> [`docs/凭证配置指南.md`](docs/凭证配置指南.md)。

1. 浏览器登录目标平台，打开 DevTools（`⌥⌘I`）→ Network → 筛 Fetch/XHR；
2. 进入「用量 / 账单 / 账户」页面，找到返回余额或积分列表的请求；
3. 复制请求头里的 `Cookie`（或 `Authorization`）填入 `credentials`
   —— 也可以直接粘贴整段 **Copy as cURL**，程序会自动剥出请求头；
4. **仅无公开接口的平台需要**：右键 → Copy as cURL，把 **URL** 填进 `options.endpoint`，
   响应 JSON 的字段路径填进 `options.mapping`。

**Qoder / Trae 不需要第 4 步**（接口已内置）。改完先跑 `npm run probe` 验证，再开浏览器。

### 示例：接入一个自建网关

```jsonc
{
  "provider": "custom",
  "displayName": "内部中转站",
  "enabled": true,
  "credentials": {},
  "options": {
    "providerId": "custom-relay",          // 多个 custom 账号靠它区分
    "endpoint": "https://relay.example.com/api/me/quota",
    "method": "GET",
    "headers": { "Authorization": "Bearer ${RELAY_TOKEN}" },
    "mapping": {
      "wrap": "data",
      "balance": { "path": "wallet.remaining", "currency": "USD" },
      "creditLots": {
        "path": "grants",
        "amount": "remaining",
        "expiresAt": "expiresAt",
        "label": "name",
        "currency": "USD"
      }
    }
  }
}
```

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary` | 聚合结果（汇总 + 各平台快照 + 到期时间线）。`?force=1` 跳过缓存强制刷新 |
| POST | `/api/refresh` | 手动刷新，body 可带 `{ "providers": ["qoder"] }` 只刷指定平台 |
| GET | `/api/providers` | 已注册的适配器清单及各自需要的凭证 |
| GET | `/api/config` | 当前配置概览（**仅凭证 key 名，不含值**）+ 告警 + 缺失环境变量 |
| GET | `/api/health` | 存活探测 |

`/api/summary` 返回结构：

```ts
{
  generatedAt: string;
  cacheTtlSeconds: number;
  expiryThresholds: { criticalDays: number; warningDays: number };
  totals: { providers, ok, failed, creditsByCurrency, balanceByCurrency };
  nextExpiry: ExpiryHit | null;      // 全局最快到期
  expiryTimeline: ExpiryHit[];       // 按到期升序
  providers: ProviderSnapshot[];     // 各平台完整快照
  warnings: string[];
  missingEnvVars: string[];
}
```

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 默认只听本机；改成 `0.0.0.0` 才对外暴露 |
| `CACHE_TTL_SECONDS` | `300` | 上游取数缓存时长 |
| `REQUEST_TIMEOUT_MS` | `12000` | 单平台请求超时 |
| `EXPIRY_CRITICAL_DAYS` | `7` | 红色高亮阈值 |
| `EXPIRY_WARNING_DAYS` | `30` | 橙色高亮阈值 |
| `ACCOUNTS_PATH` | `./accounts.json` | 账号文件路径 |

另见 `.env.example`；`src/config.ts` 内置了极简 `.env` 解析，无需 `dotenv`。

---

## 已知限制

- **所有平台都依赖浏览器登录态**，Cookie 会过期。过期后卡片会显示 `unauthorized`
  并保留上次数据（标记"数据可能过期"），重新登录 + `npm run capture` 即可。
- **Trae 的 JWT 只有 1 天有效**，但适配器会用 Cookie 自动续签，因此你只需保证 Cookie 有效。
- **批次金额有两种口径**：平台提供批次级剩余时按「剩余量」展示（Qoder / CodeArts）；
  只提供账户级剩余时按「周期授予量」展示并在界面标注（Trae / CodeBuddy），
  这类批次**不参与汇总**，只用于计算「最快到期」。
- **CodeBuddy 对请求很敏感**：WAF 校验 `User-Agent`，且会话 Cookie 挂在 `www` 子域下。
  请通过 `npm run capture` 抓取；手工配置时注意 `HTTP_USER_AGENT` 与子域 Cookie。
- **CodeBuddy / CodeArts 的接口是通过抓包定位的**，上游若改动字段，适配器会以明确的
  错误信息暴露出来（例如「响应缺少 xxx」），届时更新对应单文件即可。
- CodeArts 官方另有一套 AK/SK 签名的 API 网关，本项目优先支持网页登录态；
  若要接 AK/SK，可基于 `codearts.ts` 扩展，用 `options.headers` 注入签名头。
- 服务默认只监听 `127.0.0.1`，且不含鉴权。若要暴露到局域网，
  请自行加反向代理鉴权——因为该服务持有你所有平台的登录态。

---

## 新增一个平台

1. 在 `src/providers/` 新建 `yourPlatform.ts`，实现 `ProviderAdapter`：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  id: 'yourplatform',
  displayName: 'Your Platform',
  region: 'cn',
  dashboardUrl: 'https://...',
  requiredCredentialKeys: ['cookie'],
  credentialHint: '从哪里取到凭证',
  async probe(account, ctx) {
    const cookie = cred(account, ctx, ['cookie']);
    if (!cookie) return notConfigured(yourPlatformAdapter, account, ctx, ['cookie']);
    try {
      const { body } = await fetchJson('https://.../balance', { headers: { Cookie: cookie }, timeoutMs: ctx.timeoutMs });
      return buildSnapshot({
        adapter: yourPlatformAdapter, account, status: 'ok', now: ctx.now,
        balance: { amount: Number(body.balance), currency: 'CREDITS' },
        credits: [makeLot({ id: 'main', label: '积分包', amount: Number(body.balance), currency: 'CREDITS', expiresAt: toIso(body.expireTime) })],
        windows: [makeWindow({ kind: 'billing', label: '本期额度', used: body.used, limit: body.limit })],
      });
    } catch (error) {
      return failure(yourPlatformAdapter, account, ctx, error instanceof HttpError ? error.kind : 'error', (error as Error).message);
    }
  },
};
```

2. 在 `src/providers/index.ts` 的注册数组里加一行。
3. 在 `accounts.json` 里加一条该平台的账号。

如果用 `custom` 的声明式映射就能满足需求，则**完全不用写代码**。

---

## 技术选型说明

| 维度 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node ≥ 20.11（实测 v26）| 内置 `fetch`、`AbortSignal.timeout`、`node:test`，无 polyfill |
| 语言 | TypeScript（`tsx` 直跑，`tsc` 产物）| 适配器契约复杂，类型能挡掉大量字段拼写错误 |
| HTTP 框架 | 不使用，Node 内置 `http` + 40 行路由 | 只有 5 个接口，引入框架得不偿失；**运行时依赖为 0** |
| 前端 | 原生 HTML/CSS/JS | 无构建步骤 = 打开即用；一个看板不需要框架 |
| 前端构建 | 无 | `public/` 被后端直接托管 |

调研结论与取舍过程见 [`docs/开源项目调研与复用评估.md`](docs/开源项目调研与复用评估.md)。
