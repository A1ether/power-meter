# Power Meter · 多平台 AI 余额看板

一个标签页看完所有 AI 平台账户的余额、积分和**过期日期**，并按"最快到期"排序 / 高亮，
避免在浏览器多标签之间反复切换。

- 运行时**零第三方依赖**（只用 Node 内置模块），`npm install` 只装 `tsx` / `typescript`
- 后端聚合 + 缓存 + 失败降级，前端纯静态（无构建步骤）
- 凭证默认**不下发到浏览器**：只有被显式声明为「可托管」的密钥才提供
  掩码预览 + 按需复制（默认仅限本机），`accounts.json` / `.env` 改动后**热加载**，无需重启

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
| `npm run d1v:add -- <账号密钥> <项目密钥>` | **一条命令添加 D1V 账号**（先验证再写入，自动备份）|
| `npm run d1v:add -- --list` | 列出已配置的 D1V 账号 |
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
    ├── aggregate.ts                 # 聚合：多账号合并成一张卡片 + 汇总统计 + 到期时间线
    ├── config.ts                    # 配置加载：.env 解析、${VAR} 展开、mtime 监控
    ├── types.ts                     # 统一数据契约
    ├── cli/probe.ts                 # 命令行凭证探测工具
    ├── cli/d1v-add.ts               # 一条命令添加 D1V 账号（先验证再写入）
    ├── lib/
    │   ├── http.ts                  # 带硬超时的 fetch + HTTP/业务错误码映射
    │   ├── cache.ts                 # TTL + in-flight 去重 + last-good 兜底
    │   └── json.ts                  # 宽泛数字解析、JSON 路径取值、时间戳归一
    └── providers/                   # 平台适配器（新增平台只动这里）
        ├── base.ts                  # ProviderAdapter 契约 + 窗口/批次构建函数
        ├── index.ts                 # 注册表 + 平台别名解析
        ├── qoder.ts                 # qoder.com / qoder.com.cn / qoder.cn
        ├── trae.ts                  # trae.cn（权益包按过期时间拆批次）
        ├── codebuddy.ts             # codebuddy.cn（WAF 校验 UA）
        ├── codearts.ts              # codearts.huaweicloud.com（多接口拼批次）
        ├── d1v.ts                   # d1v.ai（API 密钥取数 + 托管 D1V_PAI_API_KEY）
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

**第三层：前端分级高亮。** 阈值可配（默认 5 天 / 14 天）：

| 剩余时间 | 视觉表现 |
| --- | --- |
| ≤ 5 天 | 红色：卡片顶部红条 + 状态点脉冲动画 + 批次左侧红边 + 顶部 danger 告警条 |
| 6~14 天 | 黄色：卡片黄边 + 批次黄边 + warning 告警条 |
| ≥ 15 天 | 绿色（safe） |
| 无过期时间 | 灰色，排序恒排最后 |

同时 `prefers-reduced-motion` 下关闭脉冲动画。

### 3. 三种取数策略，覆盖"有接口"和"没接口"

| 策略 | 适用 | 实现 |
| --- | --- | --- |
| 内置适配器 | Qoder / Trae 等有稳定接口 | `qoder.ts` / `trae.ts`，含精确字段解析与错误语义 |
| 内置适配器（API 密钥）| D1V 这类有公开 OpenAPI 的平台 | `d1v.ts`：`Authorization: Bearer <apiKey>`，无需登录态 |
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
- **配置热加载**：轮询 `accounts.json` **与 `.env`** 的 mtime，改完保存即生效——
  `npm run capture` 刷新 Cookie 后**不需要重启服务**，页面点「立即刷新」即为新凭证的取数结果。
- **凭证默认不外泄**：`/api/config` 只返回**存在哪些凭证 key**，不返回值；
  只有适配器显式声明 `revealableSecrets()` 的密钥（目前仅 D1V 的项目密钥）
  才会以掩码形式出现在快照里，明文要靠 `/api/reveal` 按需读取，且默认仅限本机；
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

除 D1V 外，其余平台的凭证都只需要 **一个 Cookie**：

| 平台 | `provider` | 需要的凭证 | 关键 `options` |
| --- | --- | --- | --- |
| Qoder | `qoder` / `qoder.cn` | `cookie` | `site: "cn"`（国内，默认）或 `"global"` |
| Trae | `trae` / `trae.cn` | `cookie` | JWT 由 Cookie 自动续签；可选 `accessToken` 覆盖 |
| CodeBuddy | `codebuddy` | `cookie`（**必须含 `www` 子域**）| — |
| CodeArts | `codearts` | `cookie`（含 `devclouddevuibjtcftk`）| 可选 `resourceType`、`region` |
| D1V | `d1v` / `d1v.ai` | `apiKey`（查余额）<br>`paiApiKey`（托管复制） | `baseUrl`、`revealApiKey` |
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

### 示例：托管多个 D1V 账号（余额 + 密钥复制）

D1V 是目前唯一**不用 Cookie、纯 API 密钥**的平台，且天然分两层密钥：

| 密钥 | 从哪来 | 能做什么 |
| --- | --- | --- |
| `D1V_API_KEY`（账号密钥）| <https://www.d1v.ai/settings?tab=api-key> 创建具名密钥，**只在创建时完整显示一次** | 查询余额、用量（`api.d1v.ai`）|
| `D1V_PAI_API_KEY`（项目密钥）| 项目 Dashboard → `Create Project Environment` 后复制 | 只能调模型（`pai.d1v.ai/v1`），**不能查余额** |

因为账号密钥不能反查项目密钥（列表接口只有 `key_prefix`，没有明文），
看板的定位就是一个**托管面板**：账号密钥用来取数，项目密钥存下来给你随时复制。

#### 加账号：一条命令

不用手工改两个文件——密钥成对出现，手抄一次就多一次抄错的机会：

```bash
npm run d1v:add -- <账号密钥> <项目密钥>
```

或者直接把整段粘贴进去（会按「项目 / 个人」关键词自动认哪把是哪把）：

```bash
npm run d1v:add -- --text "个人apikey：sk-...
对应的项目apikey：..."
```

它会依次做四件事：

1. **验证账号密钥**：调 `pai-project-usage/overview` 拿真实 quota 与邮箱，
   顺手把额度、到期时间、`quota` 与钱包的差额打出来给你确认；
2. **验证项目密钥**：打 `GET https://pai.d1v.ai/v1/models`，
   返回模型列表才算通过（这个端点只读、不花钱）；
3. **备份** `.env` 与 `accounts.json` 到 `.run/d1v-add-<时间戳>/`
   （`.run/` 已 gitignore，不会把凭证明文带进 git）；
4. 写入 `.env` 的 `D1V_<X>_API_KEY` / `D1V_<X>_PAI_API_KEY`
   （自动挑下一个空闲字母，或复用 `.env` 里已有的空槽位），
   并在 `accounts.json` 追加一条 `provider: "d1v"`。

**两把密钥都验证通过才会写文件**，任何一步失败都原样退出、不留半截配置。
账号名默认取邮箱前缀（如 `D1V · sb4hnm`），可用 `--name` 覆盖；
`--dry-run` 只验证不写入；重复添加同一把账号密钥会被拒绝（除非 `--force`）。

服务监听这两个文件的 mtime，**写完即热加载，不用重启**。
想临时停用就把该条目的 `enabled` 改成 `false`；想删除就连同 `.env` 里那两行一起删。

写完之后 `accounts.json` 里就是普通条目，也可以手工维护——多个账号就是多条
`provider: "d1v"`，靠 `displayName` 区分：

```jsonc
{
  "accounts": [
    {
      "provider": "d1v",
      "displayName": "D1V · sb4hnm",       // 多账号靠它区分，也会显示在卡片上
      "enabled": true,
      "credentials": {
        "apiKey": "${D1V_B_API_KEY}",       // 查余额
        "paiApiKey": "${D1V_B_PAI_API_KEY}" // 托管，卡片上可一键复制
      },
      "options": {
        "revealApiKey": false   // 是否也允许在卡片上复制账号密钥本身（默认 false）
      }
    }
  ]
}
```

#### ⚠ 余额单位是 QUOTA；钱包 USD 直接忽略

D1V 有两套计量，但**只有 quota 有意义**：

| 计量 | 含义 | 说明 |
| --- | --- | --- |
| `QUOTA`（`quota_remaining`）| 模型调用实际扣减的单位 | **永不过期**；为 0 时账号立刻不可用 |
| `USD`（`total_balance_usd`）| 钱包账面数字 | 不参与实际消耗，而且**系统性虚高** |

两个真实账号的实测：

```
账号 A: 钱包 $8.764224   quota 3,382,112 ≈ $6.764224   差额 $2.000000
账号 B: 钱包 $8.800000   quota 3,400,000 ≈ $6.800000   差额 $2.000000
```

换算率恒定（`1 USD = 500,000 quota`，4 条扣减记录的 `quota ÷ usd`
都精确等于 `500000.0000`），而钱包恒定比 quota 折合值多 **$2.00**。
既然 quota 不过期、USD 又不参与消耗，看板就**完全不显示 USD**——
摆一个用不上还偏大的数字只会误导人，这正是「余额还有、quota 没了」的来源。

#### 整个 D1V 只占一张卡片

一个 D1V 账号 = 一把项目密钥 + 一份 quota，天然是「同一种东西的多份」，
所以适配器声明了 `groupAccounts: true`：聚合层把所有 D1V 账号**合并成一张卡片**，
卡片里一条条列出「账号 · 托管密钥 · 可用额度」：

```
● D1V                                        [国际] [永不过期]
8,892,423 QUOTA
3 个账号
账号 · 托管密钥                                     可用额度
┌───────────────────────────────────────────────────────────┐
│ jwig5h@qabq.com                          2,110,311 QUOTA  │
│ D1V_PAI_API_KEY            [显示] [复制]                   │
│ ftWJ0G…B7tK                                               │
│ 项目：项目环境；已用 1,274,966 quota（279 次请求）           │
├───────────────────────────────────────────────────────────┤
│ mehopo8168@meinvr.com                    3,382,112 QUOTA  │
│ D1V_PAI_API_KEY            [显示] [复制]                   │
│ wITpPj…XCO7                                               │
├───────────────────────────────────────────────────────────┤
│ sb4hnm@qabq.com                          3,400,000 QUOTA  │
│ D1V_PAI_API_KEY            [显示] [复制]                   │
│ 07aHCH…1fM4                                               │
└───────────────────────────────────────────────────────────┘
```

- 条目按**额度升序**：最少的最靠前，也就是最该关注的排最前；
- 某条 quota 归零时该条标红并提示「quota 已用尽，该账号调不动」——
  这是事实判断，不需要任何阈值；
- 账号名取 `email`（比 displayName 更能认出是谁），`plan` 一行显示「N 个账号」；
- **quota 不过期，所以不参与「最快到期」**：无批次、无进度条、
  也不进到期时间线，不会去跟真正要作废的额度抢注意力。

> 副作用：因为 Quota 永不「到期风险」，D1V 卡片在默认的「最快到期优先」
> 排序里会排在最后。想让它靠前，用工具栏的排序下拉切到「按名称」，
> 或参考「已知限制」里关于低额度告警的说明。

新增账号仍然是一条命令：`npm run d1v:add -- <账号密钥> <项目密钥>`。

D1V 走的是官方 OpenAPI（<https://api.d1v.ai/api/openapi.json>），只用到两个接口：

| 用途 | 接口 |
| --- | --- |
| 可用 quota（**唯一必需**）| `GET /api/wallet/pai-project-usage/overview` |
| 账号标识（卡片里那条显示 email）| `GET /api/user/info` |
| 托管密钥读取（看板自己的接口）| `POST /api/reveal` |

托管密钥默认只显示掩码（如 `ftWJ0G…B7tK`），
点「显示」或「复制」才会通过 `/api/reveal` 按需读取明文——
**接口默认只允许本机访问**，规则见下节。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary` | 聚合结果（汇总 + 各平台快照 + 到期时间线）。`?force=1` 跳过缓存强制刷新 |
| POST | `/api/refresh` | 手动刷新，body 可带 `{ "providers": ["qoder"] }` 只刷指定平台 |
| GET | `/api/providers` | 已注册的适配器清单及各自需要的凭证 |
| GET | `/api/config` | 当前配置概览（**仅凭证 key 名，不含值**）+ 告警 + 缺失环境变量 |
| POST | `/api/reveal` | **按需读取托管密钥明文**（默认仅本机）。body `{ provider, accountId, key }` |
| GET | `/api/health` | 存活探测 |

### `POST /api/reveal` 的三道闸门

这是全项目唯一会把凭证明文下发到浏览器的接口，因此默认**只允许本机**：

1. **来源必须回环**：请求的 `Host` 与 `Origin` 都必须是 `127.0.0.1` / `localhost` / `::1`。
   服务本身默认也只监听回环地址；若把 `HOST` 改成 `0.0.0.0`，
   则必须同时显式设置 `ALLOW_SECRET_REVEAL=1` 才会放行（并在启动时打警告）。
2. **必须带自定义头** `X-Power-Meter-Intent: reveal`。
   自定义头会让跨域请求先走 CORS 预检，而本服务从不返回 `Access-Control-Allow-*`，
   预检必然失败——等于给 CSRF 上了第二把锁。
3. **必须在白名单里**：只有适配器 `revealableSecrets()` 声明过的 key 才可读，
   且必须命中 `accounts.json` 里具体某条账号。

返回值带 `Cache-Control: no-store`；服务端日志只记「读了谁」不记值；
`/api/summary` 里永远只有掩码预览（`secrets[].preview`），绝无明文。

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
| `EXPIRY_CRITICAL_DAYS` | `5` | 红色高亮阈值：≤ 该天数到期显示红色 |
| `EXPIRY_WARNING_DAYS` | `14` | 黄色高亮阈值：`criticalDays`~该天数到期显示黄色，更久显示绿色 |
| `ACCOUNTS_PATH` | `./accounts.json` | 账号文件路径 |
| `ALLOW_SECRET_REVEAL` | 未设置 | 设为 `1` 才允许非本机访问 `/api/reveal`（**前方必须已有反代鉴权**）|

另见 `.env.example`；`src/config.ts` 内置了极简 `.env` 解析，无需 `dotenv`。

---

## 已知限制

- **所有平台都依赖浏览器登录态**，Cookie 会过期。过期后卡片会显示 `unauthorized`
  并保留上次数据（标记"数据可能过期"），重新登录 + `npm run capture` 即可。
- **Trae 的 JWT 只有 1 天有效**，但适配器会用 Cookie 自动续签，因此你只需保证 Cookie 有效。
- **只展示还能用的批次**：已用尽（剩余 ≤ 0）的积分包会被丢弃，已过期的会被移出列表，
  只汇总成一句提示（如「已隐藏 5 个已用尽的积分包」）。所以卡片上的批次都是当下可用的额度。
- **批次与余额是同一份钱**：批次是余额的拆分，四个平台的批次之和都等于各自账户余额，
  因此顶部汇总只显示一个「可用额度合计」，不做二次相加。
- **CodeBuddy 对请求很敏感**：WAF 校验 `User-Agent`，且会话 Cookie 挂在 `www` 子域下。
  请通过 `npm run capture` 抓取；手工配置时注意 `HTTP_USER_AGENT` 与子域 Cookie。
- **CodeBuddy / CodeArts 的接口是通过抓包定位的**，上游若改动字段，适配器会以明确的
  错误信息暴露出来（例如「响应缺少 xxx」），届时更新对应单文件即可。
- CodeArts 官方另有一套 AK/SK 签名的 API 网关，本项目优先支持网页登录态；
  若要接 AK/SK，可基于 `codearts.ts` 扩展，用 `options.headers` 注入签名头。
- **D1V 的账号密钥会过期/轮换**：官方要求「以替换方式轮换」而不是原地覆盖，
  轮换后更新 `.env` 即可（热加载）；卡片里该条会显示 `unauthorized` 与原因。
- **D1V 用 QUOTA 计**：与其余平台的 CREDITS 都不同，顶部汇总按单位分开计，
  不做任何跨单位换算（所以「余额从少到多」这类排序在跨单位时没有可比性）。
- **D1V 完全不显示钱包 USD**：`total_balance_usd` 恒定比 quota 折合值多 \$2.00，
  且不参与实际消耗，显示它只会误导——看板只用 `quota_remaining`。
- **D1V 的额度永不过期**（卡片头部标「永不过期」），所以它没有「最快到期」：
  不进到期时间线、不触发顶部告警、没有进度条
  （没有分母就不编分母；真实数据里套餐目录 `package_info[].quota` 全为 `0`，
  真正表示额度的是 `credit_cents`，与 `use_quota` 量纲不同，硬凑分母只会显示错的进度条）。
- **D1V 卡片在默认排序里排最后**：默认是「最快到期优先」，而它永远不会到期，
  这是刻意的口径而不是 bug。想让「quota 快用完」也浮上来，
  需要给条目加一个额度阈值；目前只对 `quota = 0` 标红
  （那是事实判断，不需要拍一个阈值）。
- 服务默认只监听 `127.0.0.1`，且不含鉴权。若要暴露到局域网，
  请自行加反向代理鉴权——因为该服务持有你所有平台的登录态
  （并且 `/api/reveal` 能读出托管密钥明文）。

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

如果这个平台的**密钥值得在看板上直接复制**（例如它是模型调用凭证，
需要经常贴到别处），再补一个 `revealableSecrets`：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  // ...
  revealableSecrets: (account) => [
    { key: 'paiApiKey', label: 'YOUR_API_KEY', hint: '用于模型调用' },
  ],
};
```

声明之后，快照里的 `secrets[].preview` 会出现掩码预览，卡片自动带出「显示 / 复制」按钮，
`/api/reveal` 也只放行这里声明过的 key——**没声明 = 整条链路关闭**，
这是刻意的默认值（见 `base.ts` 的 `describeSecrets`）。

如果这个平台的**多个账号本质上是「同一种东西的多份」**
（一个账号 = 一份额度 + 一把密钥，摆成多张卡片反而看不清谁快用完了），
再加一个 `groupAccounts`：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  // ...
  groupAccounts: true,
};
```

聚合层（`aggregate.ts` 的 `groupSnapshots`）会把该平台的所有账号快照合并成
**一张卡片**：每个账号成为 `entries[]` 里的一条，按额度升序排列，
卡片顶部显示合计。适配器侧不用做任何事——每个账号照常各探各的，
合并只发生在聚合层，`/api/reveal` 靠 `entries[].id`（即该账号的 `displayName`）
定位到唯一账号。

如果这个平台的额度**永不过期**，再加上：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  // ...
  neverExpires: true,
};
```

卡片头部会打一个「永不过期」的绿色标签，替代原本的到期倒计时。
必须显式声明而不是靠「没有批次/没有到期时间」推断——
「确认不会过期」和「上游没给过期信息」是两件事，后者应该保持沉默
（CodeArts 取不到套餐信息时就是后者，它不会被贴上这个标签）。

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
