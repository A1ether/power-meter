# Power Meter · 多平台 AI 余额看板

一个标签页看完所有 AI 平台账户的余额、积分和**过期日期**，并按"最快到期"排序 / 高亮，
避免在浏览器多标签之间反复切换。

- 运行时**零第三方依赖**（只用 Node 内置模块），`npm install` 只装 `tsx` / `typescript`
- CodeBuddy / Trae 支持**扫码或打开链接登录**；Qoder 只保留**网页端登录**（自动抓 Cookie），授权后自动落库，一个账号一张卡片
- 后端聚合 + 缓存 + 失败降级，前端纯静态（无构建步骤）
- 凭证默认**不下发到浏览器**：只有被显式声明为「可托管」的密钥才提供
  掩码预览 + 按需复制（默认仅限本机），`accounts.json` / `.env` 改动后**热加载**，无需重启

> 设计、修复与取数调研文档仅保留在作者本地，不随仓库发布；
> 使用所需的信息已写在本 README 与源码注释中。

---

## 快速开始

```bash
# 1. 安装（仅开发依赖，运行时零依赖）
npm install

# 2.（可选）生成账号配置：不复制也行，看板里添加第一个账号时会自动创建
cp accounts.example.json accounts.json

# 3. 启动
npm start
# 打开 http://127.0.0.1:48213
```

### 接入自己的账号

**入口：顶栏「平台与账号」（还没有任何账号时也能用）**

打开 <http://127.0.0.1:48213> 后，点顶栏的「平台与账号」：弹窗会列出**全部内置平台**
（含一个账号都没有的平台），在这里登录、粘贴凭证或删除账号即可，不需要编辑任何文件。
已有平台想追加第二个账号也走这里（单账号卡片的右上角只有「重新登录 / 删除」，见下文）。

> 首次使用没有 `accounts.json` 也能直接添加：第一个账号保存时会自动创建该文件。

**卡片右上角：一个账号一张卡的平台是「重新登录」+「删除」**

凭证过期时点卡片额度右侧的「重新登录」，面板里就是扫码 / 网页端登录按钮组，
下面还留着「手工填写凭证（兜底）」；旁边的红色「删除」直接删掉**这张卡代表的那个账号**
（有二次确认，会同时清掉 `.env` 里不再被引用的变量，改动前自动备份到 `.run/`）。
A1etherOpenAi 是多账号合并成一张卡，卡片级没有单一账号身份，所以它右上角仍是「＋ 添加账号」，
删除挂在每条账号行上。

**CodeBuddy / Qoder / Trae：看板上直接登录（推荐）**

在「平台与账号」里选中平台（或对应卡片上点「重新登录」）→「扫码 / 打开链接登录」：

| 平台 | 登录方式 | 说明 |
| --- | --- | --- |
| CodeBuddy | 手机扫码 / 新窗口打开链接 | 用 CodeBuddy 客户端或微信完成授权 |
| WorkBuddy 国际版 | 手机扫码 / 网页端登录 | 目标固定 `codebuddy.ai`；令牌写入 `CODEBUDDY_GLOBAL_*`；网页端登录会自动打开调试 Chrome 抓 Cookie（批次明细更全） |
| Qoder 国内版 | 网页端登录 | 目标固定 `qoder.com.cn`；自动打开调试 Chrome 抓 Cookie（`QODER_COOKIE`），扫码/设备令牌已下线（拿不到逐包批次明细） |
| Qoder 国际版 | 网页端登录 | 目标固定 `qoder.com`；自动打开调试 Chrome 抓 Cookie（`QODER_GLOBAL_COOKIE`），同样只保留网页端登录 |
| Trae | 新窗口打开链接 | 回调固定 `127.0.0.1`，必须在本机浏览器完成；令牌写入 `TRAE_*` |
| Trae 国际版 | 新窗口打开链接 | 目标固定 `trae.ai`，回调同样固定 `127.0.0.1`；令牌写入 `TRAE_GLOBAL_*`，与国内版互不通用 |

授权成功后服务端会先验证取数、再把令牌写入 `.env` 并注册账号，**一个账号一张卡片**；
同一账号再次登录只刷新凭证，不会多出一张卡。令牌过期时会自动续期并写回 `.env`。

**其他平台 / 兜底：自动抓取 Cookie（约 1 分钟）**

```bash
npm run chrome:debug     # ① 弹出一个调试专用 Chrome 窗口
                         #   ② 在里面登录 Qoder / Trae / CodeBuddy / CodeArts / MiniMax Code /
                         #      商汤小浣熊 / 千问办公，并各自打开「用量 / 账单」页面
                         #      （MiniMax Code 停在 agent.minimax.cn；小浣熊停在
                         #      xiaohuanxiong.com/work/settings/resource；千问办公停在
                         #      qwenwork.cn/app/settings/usage；
                         #      Qoder 国际站账号停在 qoder.com/account/usage，用
                         #      npm run capture -- qoder-intl 抓取；
                         #      Trae 国际版账号停在 trae.ai/account-setting#usage，用
                         #      npm run capture -- trae-global 抓取）
npm run capture          # ③ 自动抓取各平台的登录态，写入 .env
npm run probe            # ④ 验证取数是否正常
# 刷新 http://127.0.0.1:48213
```

除 A1etherOpenAi（API 密钥）、MiniMax Code（网页端登录态 token + Cookie）与商汤小浣熊
（令牌藏在登录态 Cookie 里）外，其余平台（含千问办公）都只需要**一个 Cookie**，
其余全部自动完成 —— 包括 Trae 那个只有 1 天有效期的 JWT，由适配器用 Cookie 自动续签，不需要手工维护。

> 调试窗口用的是独立 profile（`~/.power-meter/chrome-profile`），与你日常的 Chrome 完全隔离。
> 原因：Chrome 136+ 禁止对默认资料目录开启远程调试端口。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动看板服务 |
| `npm run dev` | 带文件监听的热重载开发模式 |
| `npm run chrome:debug` | 启动带调试端口的独立 Chrome（抓取凭证用）|
| `npm run capture` | **自动抓取各平台的登录态并写入 `.env`** |
| `npm run capture -- codebuddy --slot 2` | 抓第二个账号的登录态，写进 `CODEBUDDY_COOKIE_2`（多账号，见下文）|
| `npm run capture -- qoder-intl` | 抓 Qoder 国际站（qoder.com）登录态，写进 `QODER_GLOBAL_COOKIE`（国内站用 `npm run capture -- qoder` → `QODER_COOKIE`）|
| `npm run capture -- trae-global` | 抓 Trae 国际版（trae.ai）登录态，写进 `TRAE_GLOBAL_COOKIE`（国内站用 `npm run capture -- trae` → `TRAE_COOKIE`）|
| `npm run capture -- xiaohuanxiong` | 抓商汤小浣熊登录态，一次写入 `XIAOHUANXIONG_COOKIE` / `XIAOHUANXIONG_TOKEN` / `XIAOHUANXIONG_REFRESH_TOKEN` |
| `npm run capture -- qwenwork` | 抓千问办公登录态，写入 `QWENWORK_COOKIE`（也可用卡片上的「网页端登录」）|
| `npm run migrate:qoder-sites --dry-run` | 预览 Qoder 旧站点配置（`options.site`）的迁移；去掉 `--dry-run` 才写入（自动备份到 `.run/`）|
| `npm run capture -- --dry-run` | 只预览，不写文件 |
| `npm run probe` | **命令行探测取数是否正常**（改配置后先跑这个最快）|
| `npm run probe -- qoder trae` | 只探测指定平台 |
| `npm run probe -- --json` | 输出机器可读结果 |
| `npm run account -- --list` | 列出已配置账号（含已停用/缺凭证，只显示掩码）|
| `npm run account -- --provider codebuddy --cookie '<值>'` | **给任意平台添加账号**（先真实验证再写入，自动备份）|
| `npm run account -- --provider codebuddy --env CODEBUDDY_COOKIE_2` | 引用 `.env` 已有变量添加账号（配合 `capture --slot`）|
| `npm run account -- --provider codebuddy --remove 'CodeBuddy · 账号 2'` | 删除账号（同时清理不再被引用的 `.env` 变量）|
| `npm run a1etheropenai:add -- <账号密钥> <项目密钥>` | **命令行添加 A1etherOpenAi 账号**（先验证再写入，自动备份）；看板上也有按钮 |
| `npm run a1etheropenai:add -- --remove "A1etherOpenAi · xxx"` | 删除 A1etherOpenAi 账号（同时清理无用的 `.env` 变量）|
| `npm run a1etheropenai:add -- --list` | 列出已配置的 A1etherOpenAi 账号 |
| `npm run typecheck` | 类型检查 |
| `npm run build && npm run serve` | 编译到 `dist/` 后以纯 JS 运行 |

各平台的凭证字段与登录入口见看板里的「平台与账号」；
`npm run probe` 的示例输出：

```
● Qoder              ok    252ms
                  余额 1200 CREDITS  最快到期 2026-12-31
                    · 赠送资源包     100   过期 2026-12-31
                    · 赠送资源包     100   过期 2026-12-31
● Trae               ok    228ms
                  余额 3500 CREDITS  最快到期 2026-12-31
                  积分额度（本期）: 3500/5000
● CodeBuddy          ok    849ms
                  余额 2800 CREDITS  最快到期 2026-12-31
● CodeArts 华为云      ok   1129ms
                  余额 8500 CREDITS  最快到期 2026-12-31
                    · 基础套餐积分   500    过期 2026-12-31
                    · 赠送积分包    8000    过期 2026-12-31
合计 4 个平台，正常 4 个，异常 0 个。
```

---

## 桌面版（macOS）

已提供 macOS 桌面版（Apple Silicon + Intel，macOS 13+），目标机器无需安装 Node：

1. 从 [Releases](https://github.com/A1ether/power-meter/releases/latest) 下载 `PowerMeter-<版本>.dmg`；
2. 拖入「应用程序」，首次打开时右键 →「打开」（应用未做 Apple 公证）；
3. 启动后点「＋ 添加平台账号」，登录或填写凭证。

配置保存在 `~/Library/Application Support/PowerMeter/`。扫码 / 网页端登录需要本机安装
Google Chrome；MiniMax Code 目前仍需手工编辑该目录下的 `.env`。

---

## 项目结构

```
power-meter/
├── package.json                     # 运行时零依赖
├── tsconfig.json                    # ESM + NodeNext
├── .env.example                     # 环境变量模板
├── accounts.example.json            # 账号配置模板（复制为 accounts.json）
├── public/                          # 前端（无构建步骤，直接被后端托管）
│   ├── index.html                   # 页面骨架 + <template> 卡片模板
│   ├── styles.css                   # 设计系统：明暗双主题、到期三色分级、脉冲高亮
│   └── app.js                       # 拉数、排序、筛选、倒计时渲染
└── src/
    ├── server.ts                    # HTTP 服务 + 路由 + 静态资源（Node 内置 http）
    ├── account-store.ts             # 通用账号增删（任何声明 manageFields 的平台，CLI 与看板接口同一份）
    ├── a1etheropenai-store.ts                 # A1etherOpenAi 账号增删的共用实现（CLI 与看板接口同一份）
    ├── service.ts                   # 编排层：并发探测、TTL 缓存、失败回退、配置热加载
    ├── aggregate.ts                 # 聚合：多账号合并成一张卡片 + 汇总统计 + 到期时间线
    ├── credit-value.ts              # 积分折人民币：各平台官方单价表 + DeepSeek V4.1 Flash 基准（调价只改这里）
    ├── config.ts                    # 配置加载：.env 解析、${VAR} 展开、mtime 监控
    ├── types.ts                     # 统一数据契约
    ├── cli/probe.ts                 # 命令行凭证探测工具
    ├── cli/account.ts               # 一条命令给任意平台增删账号（先验证再写入）
    ├── cli/a1etheropenai-add.ts               # 一条命令添加 A1etherOpenAi 账号（先验证再写入）
    ├── lib/
    │   ├── http.ts                  # 带硬超时的 fetch + HTTP/业务错误码映射
    │   ├── cache.ts                 # TTL + in-flight 去重 + last-good 兜底
    │   └── json.ts                  # 宽泛数字解析、JSON 路径取值、时间戳归一
    └── providers/                   # 平台适配器（新增平台只动这里）
        ├── base.ts                  # ProviderAdapter 契约 + 窗口/批次构建函数
        ├── index.ts                 # 注册表 + 平台别名解析
        ├── qoder.ts                 # qoder.com.cn / qoder.com / qoder.cn（site: cn | global | auto 双站点）
        ├── trae.ts                  # trae.cn（权益包按过期时间拆批次）
        ├── codebuddy.ts             # codebuddy.cn（WAF 校验 UA）
        ├── codearts.ts              # codearts.huaweicloud.com（多接口拼批次）
        ├── a1etheropenai.ts                   # d1v.ai（API 密钥取数 + 托管 A1etherOpenAi_PAI_API_KEY）
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
- 但 Qoder 的旧版报文只返回 `nextResetAt`（没有批次过期时间），如果只按批次过滤，
  Qoder 会掉出时间线——所以补了一条**合成事件**「本期额度重置（未用完即作废）」，
  金额取该平台积分合计。这让"重置即作废"的平台也能参与排序。
- 新版报文（含令牌模式的 openapi 接口）会给出 `dedicated_resource_packages[].expires_at`，
  这类批次按真实到期参与排序，不再依赖合成事件。
- 注意：令牌模式只能拿到**账户级额度分桶**（套餐 / 赠送 / 团队共享）；
  网页上那种「N 个 Credit Pack、每个包各自剩余与到期」的逐包明细需要 Cookie 模式。

**每条事件还会带一个人民币估值**（时间线行内的 `≈ ¥X`，鼠标悬停出换算口径），口径集中在
`src/credit-value.ts` 一张表里：

| 口径 | 含义 | 数据来源 |
| --- | --- | --- |
| **官方口径**（界面主数字） | 平台自己卖的「积分包 / 增购积分」单价 | Trae / CodeBuddy / CodeArts 均 ¥50 / 1,000 积分 = ¥0.05/积分；Qoder CN 专业版 ¥59 / 月含 2,000 Credits = ¥0.0295；MiniMax 积分包 ≈ ¥7 / 1,000 积分；商汤小浣熊加油包大包 ¥19.9 / 1,200 积分 ≈ ¥16.58 / 1,000；千问办公标准版 ¥78 / 月含 2,000 积分 = ¥0.039/积分；Qoder 国际站 $20 / 1,500 Credits 按 `USD_CNY = 7.1` 折人民币 |
| **DeepSeek V4.1 Flash 基准**（悬停里的补充） | 假设这些积分全部用在 DeepSeek V4.1 Flash 上，这批用量若直接接 DeepSeek 官方要花多少钱 | 算法 = 官方金额 × 比值，比值 = DeepSeek 官方单价 ÷ 平台该模型 token 单价。**只有平台公布了该模型 token 单价才能算**（输入 / 输出 / 缓存三项比值一致，用量里输入输出的配比会自动消掉） |

- 目前**只有 Trae 能算出基准口径**：Trae 公布该模型 token 单价 ¥2 / ¥8 / ¥0.04 每百万
  （企业版计费项），恰为 DeepSeek 官方空闲档（¥1 / ¥4 / ¥0.02）的 2 倍 ⇒ 「基准 ≈ 官方金额 × 0.5」。
- Qoder（系数 0.1×）、CodeArts（系数 0.18）只公布**模型间的相对系数**，缺「1× 基准 = 每千 token
  多少积分」这一环，CodeBuddy 连系数都没有——这些**不编数字**，悬停里写明缺哪一环。
- **不折算的情况**：`QUOTA` / `USD` / `CNY` 单位（A1etherOpenAi 的 quota 与美元钱包是同一笔钱的
  两套计量，只按原单位显示），以及 `custom` / `demo:*` 这类没有官方单价的平台。
- DeepSeek 官方单价取**空闲档**（高峰档为 2 倍）；估值只影响显示，不参与「最快到期」排序与汇总口径。

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
| 内置适配器（API 密钥）| A1etherOpenAi 这类有公开 OpenAPI 的平台 | `a1etheropenai.ts`：`Authorization: Bearer <apiKey>`，无需登录态 |
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
  只有适配器显式声明 `revealableSecrets()` 的密钥（目前仅 A1etherOpenAi 的项目密钥）
  才会以掩码形式出现在快照里，明文要靠 `/api/reveal` 按需读取；
  而 `/api/reveal` 与 `/api/accounts*`（含遗留的 `/api/a1etheropenai/accounts*`）都属于本机特权接口，默认只允许回环来源
  （见上文「三道闸门」）；
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
  "provider": "qoder-intl",         // 平台 id，支持别名，见下表
  "displayName": "Qoder 国际版",      // 可选，自定义展示名
  "enabled": true,
  "credentials": { "cookie": "${QODER_GLOBAL_COOKIE}" },  // 敏感值，建议引用环境变量
  "options": {}                      // 非敏感配置
}
```

`credentials` / `options` 里任何字符串都支持 `${ENV_VAR}` 占位符；
缺失的环境变量会在界面「诊断」区和 `npm run probe` 里明确列出变量名。

### 各平台配置

除 A1etherOpenAi（API 密钥）、MiniMax Code（网页登录态或 OAuth 令牌）、商汤小浣熊（令牌藏在 Cookie 里）
与 CodeArts（推荐 AK/SK）外，其余平台（含千问办公）的凭证都只需要 **一个 Cookie**：

| 平台 | `provider` | 需要的凭证 | 关键 `options` |
| --- | --- | --- | --- |
| Qoder 国内版 | `qoder` / `qoder.cn` | `cookie`（`QODER_COOKIE`）<br>或历史扫码登录写入的 `accessToken` + `refreshToken`（`QODER_ACCESS_TOKEN` / `QODER_REFRESH_TOKEN`；扫码入口已下线，仅供既有账号使用） | 站点固定 `qoder.com.cn`，无站点选项；`origin` 可覆盖为自定义域名/代理。两种凭证模式都会拆积分批次：Cookie 模式给出逐包明细（`quota_detail[]`），令牌模式只能给出账户级分桶 + 可选的 `dedicated_resource_packages[]`（逐包明细需 Cookie） |
| Qoder 国际版 | `qoder-intl` / `qoder.com` / `qoder-global` | `cookie`（`QODER_GLOBAL_COOKIE`）<br>或历史登录写入的 `accessToken` + `refreshToken`（`QODER_GLOBAL_ACCESS_TOKEN` / `QODER_GLOBAL_REFRESH_TOKEN`；扫码入口已下线，仅供既有账号使用） | 站点固定 `qoder.com`，无站点选项；`origin` 可覆盖。积分批次口径与国内版一致 |
| Trae | `trae` / `trae.cn` | `cookie`（`TRAE_COOKIE`）<br>或「打开链接登录」写入的 `accessToken` + `refreshToken` + `deviceKey`（`TRAE_ACCESS_TOKEN` / `TRAE_REFRESH_TOKEN` / `TRAE_DEVICE_KEY`） | JWT 由 Cookie 自动续签；令牌模式由 `deviceKey` 签名续期 |
| Trae 国际版 | `trae-global` / `trae.ai` | `cookie`（`TRAE_GLOBAL_COOKIE`）<br>或「打开链接登录」写入的 `accessToken` + `refreshToken` + `deviceKey`（`TRAE_GLOBAL_ACCESS_TOKEN` / `TRAE_GLOBAL_REFRESH_TOKEN` / `TRAE_GLOBAL_DEVICE_KEY`） | 站点固定 `trae.ai`，与国内版互不通用；计费面是 v1 `user_current_entitlement_list`，余额按账户口径显示美元 / 积分 / 请求次数（`options.apiHost`、`options.usageUrl` 可覆盖主机） |
| CodeBuddy | `codebuddy` | `cookie`（**必须含 `www` 子域**）<br>或扫码登录写入的 `accessToken` + `refreshToken`（`CODEBUDDY_ACCESS_TOKEN` / `CODEBUDDY_REFRESH_TOKEN`）| — |
| WorkBuddy 国际版 | `codebuddy-intl` / `codebuddy.ai` / `workbuddy.ai` | `cookie`（**必须含 `www` 子域**，写 `CODEBUDDY_GLOBAL_COOKIE`）<br>或扫码登录写入的 `accessToken` + `refreshToken`（`CODEBUDDY_GLOBAL_ACCESS_TOKEN` / `CODEBUDDY_GLOBAL_REFRESH_TOKEN`）| 站点固定 `codebuddy.ai`，与国内版互不通用 |
| CodeArts | `codearts` | **网页端登录（推荐，一键添加）**：卡片上点「网页端登录」，在自动打开的调试 Chrome 里登录华为云即可，Cookie 自动落 `CODEARTS_COOKIE` 并由 `npm run codearts:refresh` 定时续期<br>`accessKey` + `secretKey`（长期有效，多账号路径）<br>`cookie`（兼容，会话过期需重抓） | 可选 `authMode: "auto" \| "aksk" \| "cookie"`、`resourceType`、`region` |
| MiniMax Code | `minimax` / `minimax-code` / `agent.minimax.cn` | **扫码登录（推荐，一键添加）**：卡片上点「扫码登录」，手机确认后写入 `accessToken` + `refreshToken`（`MINIMAX_ACCESS_TOKEN` / `MINIMAX_REFRESH_TOKEN`）<br>**网页端登录（一键添加）**：在自动打开的调试 Chrome 里登录 `agent.minimax.cn`，自动抓取 `token`（`_token`）+ `cookie`（SSO）+ 真实身份 `userId`/`opTicket`/`uuid`<br>手工兜底：`token` + `cookie` + `userId` | `site: "cn"`（默认）或 `"global"`；`authMode: "web" \| "oauth"`（登录自动写入） |
| 千问办公 | `qwenwork` / `qwenwork.cn` / `qwen-office` | `cookie`（`QWENWORK_COOKIE`，网页登录态；生产环境不带 `Authorization`）| 无；`origin` 可覆盖为代理地址 |
| 商汤小浣熊 | `xiaohuanxiong` / `xiaohuanxiong.com` / `raccoon` | `token`（`XIAOHUANXIONG_TOKEN`，可从 Cookie 的 `xhx_token` / `raccoon_token` 推导）+ `cookie` + `refreshToken`（capture / 网页端登录一并写入）| 无；`origin` 可覆盖为代理地址 |
| A1etherOpenAi | `a1etheropenai` / `d1v.ai`（上游服务域名保持不变，也是它的解析别名） | `apiKey`（查余额）<br>`paiApiKey`（托管复制） | `baseUrl`、`revealApiKey` |
| 任意平台 | `custom` | 按需 `headers` | `providerId`、`endpoint`、`mapping` |
| 示例数据 | `demo:qoder` / `demo:trae` / `demo:codebuddy` / `demo:codearts` / `demo:no-expiry` | 无 | — |

另有一个全局变量 `HTTP_USER_AGENT`：**CodeBuddy 的 WAF 会校验 UA**，
缺失或版本过旧会直接 401，`npm run capture` 会自动写入本机浏览器的真实 UA。

#### 一个平台多个账号（例：两个 CodeBuddy 账号）

同一个平台支持任意多个账号：**每个账号一份凭证 + 一条 `displayName` 唯一的配置**，
各自一张卡片、各自的余额、积分批次与「最快到期」。

推荐走顶栏「平台与账号」→ 选 CodeBuddy →「扫码登录」：另一个账号登录后会**新增**一张卡片
（登录身份按平台账号 ID 去重，同一账号重复登录只更新凭证，也就是卡片上的「重新登录」）。
下文的 Cookie 槽位方式仍然可用，适合 Qoder 国际版或无法扫码的场景。

```bash
npm run capture -- codebuddy --slot 2    # ② 抓第二个账号（在调试 Chrome 里登录它）→ CODEBUDDY_COOKIE_2
npm run account -- --provider codebuddy \
  --env CODEBUDDY_COOKIE_2 --name 'CodeBuddy · 账号 2'   # ③ 验证并注册成账号
npm run probe -- codebuddy               # ④ 验证取数，然后刷新看板
```

也可以全程在看板上完成：顶栏「平台与账号」→ 选平台 → 展开「手工填写凭证」→ 粘贴 Cookie →
「验证并添加」，服务会自己分配 `.env` 槽位（第二个账号 = `CODEBUDDY_COOKIE_2`）并命名。
同一份表单在卡片上也有（点「重新登录」展开），但它走的是**新增账号**接口；
要刷新卡片自己那份凭证，用面板里的登录按钮（同一平台账号只更新凭证、不新增卡片）。

| 规则 | 说明 |
| --- | --- |
| `displayName` 必须唯一 | 它是账号的稳定标识（缓存键、本地用量采样、读密钥、删除都靠它）；重名时看板「诊断」区会告警，且两个账号会互相覆盖取数结果 |
| CodeBuddy 每个账号各占一张卡片 | 它的积分包带真实到期时间，合并成一张卡会丢掉各自的批次与「最快到期」 |
| 凭证按槽位抓取 | 第一个账号 `npm run capture -- codebuddy`，第二个账号加 `--slot 2`，互不覆盖 |
| 增删都先验证 | 看板按钮与 `npm run account` 是同一份实现（`src/account-store.ts`）：先真实调用平台接口验证，通过才写盘，写入前备份到 `.run/` |

#### 取 Cookie / Token 的通用步骤

> 每个平台的凭证字段可在看板「平台与账号」里查看；登录入口会按平台动态展示。

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

### 示例：托管多个 A1etherOpenAi 账号（余额 + 密钥复制）

A1etherOpenAi 是目前唯一**不用 Cookie、纯 API 密钥**的平台，且天然分两层密钥：

| 密钥 | 从哪来 | 能做什么 |
| --- | --- | --- |
| `A1etherOpenAi_API_KEY`（账号密钥）| <https://www.d1v.ai/settings?tab=api-key> 创建具名密钥，**只在创建时完整显示一次** | 查询余额、用量（`api.d1v.ai`）|
| `A1etherOpenAi_PAI_API_KEY`（项目密钥）| 项目 Dashboard → `Create Project Environment` 后复制 | 只能调模型（`pai.d1v.ai/v1`），**不能查余额** |

因为账号密钥不能反查项目密钥（列表接口只有 `key_prefix`，没有明文），
看板的定位就是一个**托管面板**：账号密钥用来取数，项目密钥存下来给你随时复制。

#### 加 / 删账号：看板上直接点

A1etherOpenAi 卡片上就有入口：

- **添加**：点额度右侧的「＋ 添加账号」→ 填「个人 apikey」「对应的项目 apikey」→「验证并添加」；
- **删除**：每条账号的「显示 / 复制」右边有个同款红色按钮「删除」，确认后即删
  （同时清掉 `.env` 里不再被引用的变量）。

两者都**先验证再落盘**：任何一步失败都原样退出，还会先把两个文件备份到 `.run/`。
写完后服务监听文件变化自动热加载，不用重启。

卡片上只列「启用的、能取数的」账号，而停用或缺凭证的账号同样要能删——
所以展开管理区时会额外拉一次 `/api/accounts?provider=a1etheropenai`，把这列账号放在下方兜底区里
（单账号卡片则列出该平台的全部账号并标出当前卡片，见「一个平台多个账号」）。

#### 或者用命令行

不想开浏览器时，终端里是同一份实现（`src/a1etheropenai-store.ts`）：

```bash
npm run a1etheropenai:add -- <账号密钥> <项目密钥>
npm run a1etheropenai:add -- --text "个人apikey：sk-xxx
对应的项目apikey：yyy"
npm run a1etheropenai:add -- --remove "A1etherOpenAi · abcd12"
npm run a1etheropenai:add -- --list
```

它会依次做四件事：

1. **验证账号密钥**：调 `pai-project-usage/overview` 拿真实 quota 与邮箱，
   顺手把额度、已用量打出来给你确认；
2. **验证项目密钥**：打 `GET https://pai.d1v.ai/v1/models`，
   返回模型列表才算通过（这个端点只读、不花钱）；
3. **备份** `.env` 与 `accounts.json` 到 `.run/a1etheropenai-<op>-<时间戳>/`
   （`.run/` 已 gitignore：备份不能放 `.env.bak` 这种同目录文件，
   因为 `.env` 被忽略而 `.env.bak` 不会，那等于把凭证明文摆进 git 工作区）；
4. 写入 `.env` 的 `A1etherOpenAi_<X>_API_KEY` / `A1etherOpenAi_<X>_PAI_API_KEY`
   （自动挑下一个空闲字母，或复用 `.env` 里已有的空槽位），
   并在 `accounts.json` 追加一条 `provider: "a1etheropenai"`。

**两把密钥都验证通过才会写文件**，任何一步失败都原样退出、不留半截配置。
账号名默认取邮箱前缀（如 `A1etherOpenAi · efgh34`），撞名会自动补 `-2`；
`--dry-run` 只验证不写入；重复添加同一把账号密钥会被拒绝（除非 `--force`）。

删除时只清理**不再被任何账号引用**的 `.env` 变量——槽位是按字母复用的，
按名字无脑删有可能把别的账号还在用的那把钥匙一起删掉。

服务监听这两个文件的 mtime，**写完即热加载，不用重启**。
写完之后 `accounts.json` 里就是普通条目，也可以手工维护——多个账号就是多条
`provider: "a1etheropenai"`，靠 `displayName` 区分（它同时是 `/api/reveal` 与删除操作的定位键，
所以不能重名）：

```jsonc
{
  "accounts": [
    {
      "provider": "a1etheropenai",
      "displayName": "A1etherOpenAi · efgh34",       // 多账号靠它区分，也会显示在卡片上
      "enabled": true,
      "credentials": {
        "apiKey": "${A1etherOpenAi_B_API_KEY}",       // 查余额
        "paiApiKey": "${A1etherOpenAi_B_PAI_API_KEY}" // 托管，卡片上可一键复制
      },
      "options": {
        "revealApiKey": false   // 是否也允许在卡片上复制账号密钥本身（默认 false）
      }
    }
  ]
}
```

#### ⚠ 余额单位是 QUOTA；钱包 USD 直接忽略

A1etherOpenAi 有两套计量，但**只有 quota 有意义**：

| 计量 | 含义 | 说明 |
| --- | --- | --- |
| `QUOTA`（`quota_remaining`）| 模型调用实际扣减的单位 | **永不过期**；为 0 时账号立刻不可用 |
| `USD`（`total_balance_usd`）| 钱包账面数字 | 不参与实际消耗，而且**系统性虚高** |

两个真实账号的实测：

```
账号 A: 钱包 $8.000000   quota 3,000,000 ≈ $6.000000   差额 $2.000000
账号 B: 钱包 $8.000000   quota 3,000,000 ≈ $6.000000   差额 $2.000000
```

换算率恒定（`1 USD = 500,000 quota`，4 条扣减记录的 `quota ÷ usd`
都精确等于 `500000.0000`），而钱包恒定比 quota 折合值多 **$2.00**。
既然 quota 不过期、USD 又不参与消耗，看板就**完全不显示 USD**——
摆一个用不上还偏大的数字只会误导人，这正是「余额还有、quota 没了」的来源。

#### 整个 A1etherOpenAi 只占一张卡片

一个 A1etherOpenAi 账号 = 一把项目密钥 + 一份 quota，天然是「同一种东西的多份」，
所以适配器声明了 `groupAccounts: true`：聚合层把所有 A1etherOpenAi 账号**合并成一张卡片**，
卡片里一条条列出「账号 · 托管密钥 · 可用额度」：

```
● A1etherOpenAi                                        [国际] [永不过期]
1,000,000 QUOTA                             [＋ 添加账号]
4 个账号
账号 · 托管密钥                                     可用额度
┌───────────────────────────────────────────────────────────┐
│ account1@example.com                       200,000 QUOTA    │
│ A1etherOpenAi_B_PAI_API_KEY  [显示] [复制] [删除]              │
│ EXAMPLE…0000                                               │
│ 已用 50,000 quota（12 次请求）                              │
├───────────────────────────────────────────────────────────┤
│ account2@example.com                       300,000 QUOTA    │
│ A1etherOpenAi_B_PAI_API_KEY  [显示] [复制] [删除]              │
│ EXAMPLE…0000                                               │
└───────────────────────────────────────────────────────────┘
                展开其余 2 个 ⌄
```

- 条目按**额度升序**：最少的最靠前，也就是最该关注的排最前；
- 某条 quota 归零时该条标红并提示「quota 已用尽，该账号调不动」——
  这是事实判断，不需要任何阈值；
- 账号名取 `email`（比 displayName 更能认出是谁），`plan` 一行显示「N 个账号」；
- **默认只列 2 个账号，其余折叠**，点「展开其余 N 个」展开——
  与「可用积分批次」是同一套交互，免得账号一多就把卡片撑爆；
- 「显示 / 复制 / 删除」**同一条水平线**，都是同款药丸按钮（删除常驻红色）；
- 「＋ 添加账号」贴在**额度右侧**（额度行最右），表单展开在下面；
- **quota 不过期，所以不参与「最快到期」**：无批次、无进度条、
  也不进到期时间线，不会去跟真正要作废的额度抢注意力。

> 副作用：因为 Quota 永不「到期风险」，A1etherOpenAi 卡片在默认的「最快到期优先」
> 排序里会排在最后。想让它靠前，用工具栏的排序下拉切到「按名称」，
> 或参考「已知限制」里关于低额度告警的说明。

新增账号点额度右侧的「＋ 添加账号」即可（也可用 `npm run a1etheropenai:add`），
每条账号的红色「删除」按钮与「显示 / 复制」同一行。

A1etherOpenAi 走的是官方 OpenAPI（<https://api.d1v.ai/api/openapi.json>），只用到两个接口：

| 用途 | 接口 |
| --- | --- |
| 可用 quota（**唯一必需**）| `GET /api/wallet/pai-project-usage/overview` |
| 账号标识（卡片里那条显示 email）| `GET /api/user/info` |
| 托管密钥读取（看板自己的接口）| `POST /api/reveal` |

托管密钥默认只显示掩码（如 `EXAMPLE…0000`），
点「显示」或「复制」才会通过 `/api/reveal` 按需读取明文——
**接口默认只允许本机访问**，规则见下节。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary` | 聚合结果（汇总 + 各平台快照 + 到期时间线）。`?force=1` 跳过缓存强制刷新 |
| POST | `/api/refresh` | 手动刷新，body 可带 `{ "providers": ["qoder"] }` 只刷指定平台 |
| GET | `/api/providers` | 已注册的适配器清单、各自需要的凭证，以及「添加账号」表单的字段声明（`manageFields`）|
| GET | `/api/config` | 当前配置概览（**仅凭证 key 名，不含值**）+ 告警 + 缺失环境变量 |
| POST | `/api/reveal` | **按需读取托管密钥明文**（默认仅本机）。body `{ provider, accountId, key }` |
| GET | `/api/accounts?provider=` | 某平台的账号清单（含已停用 / 缺凭证的，仍只回显掩码）|
| POST | `/api/accounts/add` | **通用添加账号**（声明了 `manageAccounts` + `manageFields` 的平台）：body `{ provider, credentials? \| envRefs?, name?, force?, dryRun? }`，先真实验证通过才写盘 |
| POST | `/api/accounts/remove` | **通用删除账号**：body `{ provider, accountId }`，顺带清掉不再被引用的 `.env` 变量 |
| POST | `/api/login/start` | **发起扫码 / 链接登录**（声明了 `login` 的平台）：body `{ provider, options? }`，返回会话（含 `authUrl`，**不含令牌**）|
| GET | `/api/login/poll?id=` | 读登录会话状态（`waiting` / `landing` / `ready` / `failed` / `expired` / `cancelled`）|
| POST | `/api/login/cancel` | 取消登录会话：body `{ id }` |
| GET | `/authorize` | Trae 的 OAuth 回调（只接受回环 Host 与活跃登录会话，只投递授权码，不返回令牌）|
| GET | `/api/a1etheropenai/accounts` | A1etherOpenAi 账号清单（兼容保留；通用接口已覆盖）|
| POST | `/api/a1etheropenai/accounts` | **添加 A1etherOpenAi 账号**：先验证两把密钥，通过才写盘。body `{ apiKey, paiKey, name?, force? }` |
| POST | `/api/a1etheropenai/accounts/remove` | **删除 A1etherOpenAi 账号**：body `{ accountId }`，顺带清掉不再被引用的 `.env` 变量 |
| GET | `/api/health` | 存活探测 |

### 本机特权接口的三道闸门

`/api/reveal` 能读出凭证明文，`/api/accounts*`（及其兼容路由 `/api/a1etheropenai/accounts*`）
与 `/api/login/*` 能改动本机配置文件（登录接口还会向上游发起认证请求），
所以这几个接口共用同一道闸门，默认**只允许本机**：

1. **来源必须回环**：请求的 `Host` 与 `Origin` 都必须是 `127.0.0.1` / `localhost` / `::1`。
   服务本身默认也只监听回环地址；若把 `HOST` 改成 `0.0.0.0`，
   则必须同时显式设置 `ALLOW_SECRET_REVEAL=1` 才会放行（并在启动时打警告）。
2. **必须带自定义头** `X-Power-Meter-Intent`（值不限）。
   自定义头会让跨域请求先走 CORS 预检，而本服务从不返回 `Access-Control-Allow-*`，
   预检必然失败——等于给 CSRF 上了第二把锁。
   否则 `evil.com` 只要一段 JS 就能 POST 到 `127.0.0.1` 读走密钥或删掉账号。
3. **读密钥还要在白名单里**：只有适配器 `revealableSecrets()` 声明过的 key 才可读，
   且必须命中 `accounts.json` 里具体某条账号。

Trae 的 OAuth 回调 `/authorize` 是唯一例外：浏览器从 trae.cn 跳回来时不带自定义头，
因此它单独校验「回环 Host + `lt` 命中活跃会话 + 授权页域名在白名单内」，且只投递授权码、不返回任何令牌。
登录接口的响应里也永远不出现 `accessToken` / `refreshToken` / 设备私钥。

返回值带 `Cache-Control: no-store`；服务端日志只记「读了谁 / 改了谁」不记值；
`/api/summary` 里永远只有掩码预览（`secrets[].preview`、`entries[].secrets[].preview`），绝无明文。

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
| `PORT` | `48213` | 监听端口 |
| `HOST` | `127.0.0.1` | 默认只听本机；改成 `0.0.0.0` 才对外暴露 |
| `CACHE_TTL_SECONDS` | `300` | 上游取数缓存时长 |
| `REQUEST_TIMEOUT_MS` | `12000` | 单平台请求超时 |
| `EXPIRY_CRITICAL_DAYS` | `5` | 红色高亮阈值：≤ 该天数到期显示红色 |
| `EXPIRY_WARNING_DAYS` | `14` | 黄色高亮阈值：`criticalDays`~该天数到期显示黄色，更久显示绿色 |
| `ACCOUNTS_PATH` | `./accounts.json` | 账号文件路径 |
| `ALLOW_SECRET_REVEAL` | 未设置 | 设为 `1` 才允许非本机访问本机特权接口（读密钥 `/api/reveal`、增删账号 `/api/accounts*` 与 `/api/a1etheropenai/accounts*`）（**前方必须已有反代鉴权**）|

另见 `.env.example`；`src/config.ts` 内置了极简 `.env` 解析，无需 `dotenv`。

---

## 已知限制

- **所有平台都依赖浏览器登录态**，Cookie 会过期。过期后卡片会显示 `unauthorized`
  并保留上次数据（标记"数据可能过期"），重新登录 + `npm run capture` 即可。
- **Trae 的 JWT 只有 1 天有效**，但适配器会用 Cookie 自动续签，因此你只需保证 Cookie 有效。
- **MiniMax Code 取的是客户端内部云接口**（官方未公开 API，对应 App 里的「积分明细」）：
  签到积分自到账起 30 天有效，过期批次会移出列表；平台控制台 `console/plan` 上的「积分」
  是已购积分口径，与签到积分不是同一笔账，显示 0 属正常。两种登录态都支持：
  - 「扫码登录」走 MiniMax Code 的 OAuth 设备码（`account.minimax.cn/oauth2/device/code`），
    写入 `accessToken` / `refreshToken`，accessToken 临近过期时会自动续期并写回 `.env`；
  - 「网页端登录」打开调试 Chrome，自动抓取 `_token` + SSO Cookie + 真实身份参数
    （user_id/op_ticket/uuid，服务端会与 token 交叉校验，不能用 0 顶替）。
  `npm run capture -- minimax` 仍可手工抓取；登录态失效后卡片显示 `unauthorized`，重新登录即可。
  已配置的账号可在卡片右上角「删除」或「平台与账号」弹窗里删除（删除前自动备份到 `.run/`）。
- **千问办公取的是网页端内部接口**（没有公开查询 API）：
  `GET /user/balance` 给「剩余可用」，`GET /user/wallets` 给三桶构成
  （`daily_credits` / `monthly_credits` / `longterm_credits` 各自的 `total_balance`），
  `GET /user/billings` 给逐笔流水。卡片按页面的三桶拆批次：**每日刷新积分**（北京时间 00:00 刷新，
  当日未用完失效）、**每月订阅积分**（`plan.next_refresh_date`；取不到时按「北京时间本月末」推算并注明）、
  **长期积分**（充值 / 活动赠送，有效期「以具体规则为准」，拿不到日期就不标，不参与「最快到期」）。
  鉴权只认**登录态 Cookie**（手机验证码 / Google / 钉钉登录都会写入），所以
  `npm run capture -- qwenwork` 只写 `QWENWORK_COOKIE`；登录态 Cookie 名随登录方式而变，
  看板「网页端登录」用「页面自己请求 `/user/balance` 拿到 2xx」作为登录判据。
  企业版配额（`/biz/user/v1/settings/enterprise/quota`）是另一套鉴权与口径，本轮未纳入，
  企业账号仍能看到个人积分三桶。
- **商汤小浣熊取的是网页端内部接口**（官方只公开「积分规则」，没有查询 API）：
  `GET /api/web/points/v1/balance` 给四类积分的当前剩余，`GET /api/web/points/v2/bills`
  给发放 / 消耗流水。卡片按官方口径拆成四个批次：**每日赠送**（当日 24:00 失效，当天登录延长至
  7 天）、**每月赠送**（随订阅周期）、**加油包**（永久有效，不参与「最快到期」）、**奖励积分**（1 年）。
  鉴权只认 `Authorization: Bearer`，令牌就在登录态 Cookie 的 `xhx_token` / `raccoon_token` 里，
  所以 `npm run capture -- xiaohuanxiong` 会同时写 Cookie、令牌与刷新令牌三个变量；
  令牌过期时适配器用刷新令牌自动续期。单笔批次的剩余量平台不提供，批次金额取的是
  各桶账户级剩余（合计与「可用积分」对得上；对不上时卡片会注明）。
- **只展示还能用的批次**：已用尽（剩余 ≤ 0）的积分包会被丢弃，已过期的会被移出列表，
  只汇总成一句提示（如「已隐藏 5 个已用尽的积分包」）。所以卡片上的批次都是当下可用的额度。
- **批次与余额是同一份钱**：批次是余额的拆分，各平台的批次之和都等于各自账户余额，
  因此顶部汇总只显示一个「可用额度合计」，不做二次相加。
- **CodeBuddy 对请求很敏感**：WAF 校验 `User-Agent`，且会话 Cookie 挂在 `www` 子域下。
  请通过 `npm run capture` 抓取；手工配置时注意 `HTTP_USER_AGENT` 与子域 Cookie。
- **CodeBuddy / CodeArts 的接口是通过抓包定位的**，上游若改动字段，适配器会以明确的
  错误信息暴露出来（例如「响应缺少 xxx」），届时更新对应单文件即可。
- CodeArts 官方另有一套 AK/SK 签名的 API 网关（snap-access），本项目已接入并在有 AK/SK 时优先使用；
  AK/SK 与 Cookie 都可以在「平台与账号」里直接添加（AK/SK 成对必填，Cookie 可选、只增强活动逐笔明细）。
- **A1etherOpenAi 的账号密钥会过期/轮换**：官方要求「以替换方式轮换」而不是原地覆盖，
  轮换后更新 `.env` 即可（热加载）；卡片里该条会显示 `unauthorized` 与原因。
- **A1etherOpenAi 用 QUOTA 计**：与其余平台的 CREDITS 都不同，顶部汇总按单位分开计，
  不做任何跨单位换算（所以「余额从少到多」这类排序在跨单位时没有可比性）。
- **A1etherOpenAi 完全不显示钱包 USD**：`total_balance_usd` 恒定比 quota 折合值多 \$2.00，
  且不参与实际消耗，显示它只会误导——看板只用 `quota_remaining`。
- **A1etherOpenAi 的额度永不过期**（卡片头部标「永不过期」），所以它没有「最快到期」：
  不进到期时间线、不触发顶部告警、没有进度条
  （没有分母就不编分母；真实数据里套餐目录 `package_info[].quota` 全为 `0`，
  真正表示额度的是 `credit_cents`，与 `use_quota` 量纲不同，硬凑分母只会显示错的进度条）。
- **A1etherOpenAi 卡片在默认排序里排最后**：默认是「最快到期优先」，而它永远不会到期，
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
  usageUrl: 'https://.../usage',
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

> 注意：合并卡片的 `credits` / `windows` / `nextExpiryAt` 会被清空
> （合并后这些字段该以谁为准没有唯一答案）。所以**额度带真实到期时间的平台别声明它**
> ——CodeBuddy 就因此保持「一账号一张卡片」，让每个账号的积分批次都留在「最快到期」时间线里。

如果这个平台**想让用户在界面上直接增删账号**（不必手工改 `accounts.json`），
声明 `manageAccounts` + `manageFields` 即可接入通用实现（`/api/accounts*` 与 `npm run account`）：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  // ...
  manageAccounts: true,
  manageFields: [
    { key: 'cookie', label: 'Cookie', placeholder: '从 DevTools 复制整段 Cookie', multiline: true },
  ],
  manageHint: 'Cookie 会先真实验证，通过了才写入本机配置；写入前自动备份。',
};
```

`manageFields[].key` 必须是该平台 `credentials` 里的键；`.env` 变量名默认推导为
`<平台 id>_<字段名>`（如 `CODEBUDDY_COOKIE`），第 N 个账号自动用 `_N` 后缀（`CODEBUDDY_COOKIE_2`）——
命名不符的平台（如 CodeArts 的 `CODEARTS_AK`）用 `envNames` 显式声明。
前端表单、增删接口、CLI 命令都会照着这份声明工作，**不需要改前端代码**。

如果这个平台**支持扫码或打开链接登录**，再声明一个 `login` 能力，
前端会自动出现「扫码 / 打开链接登录」按钮，登录成功后由 `src/login-session.ts`
统一完成「probe 验证 → 按平台账号 ID 去重 → 写 `.env` + `accounts.json`」：

```ts
export const yourPlatformAdapter: ProviderAdapter = {
  // ...
  envNames: { accessToken: 'YOUR_ACCESS_TOKEN', refreshToken: 'YOUR_REFRESH_TOKEN' },
  // 令牌与 Cookie 二选一即可；决定「缺凭证」提示是否出现
  isConfigured: (account) => Boolean(account.credentials.cookie) || Boolean(account.credentials.accessToken),
  login: {
    label: '扫码登录',
    hint: '用手机 App 扫码，或在新窗口打开链接完成授权。',
    qr: true,                       // false = 只能本机打开链接（如 Trae 的 127.0.0.1 回调）
    intervalMs: 2000,               // 服务端后台轮询上游的间隔
    async start(input) {
      // 申请 authUrl；input.secret 里的内容只留在服务端内存
      return { authUrl, qr: true, ttlMs: 5 * 60_000, secret: { state } };
    },
    async poll(secret, ctx) {
      // 返回 waiting / failed / ready；ready 时给出平台账号 id、昵称与登录产物凭证
      return { status: 'ready', account: { id, name }, credentials: {}, options: {} };
    },
  },
};
```

令牌过期时在 `probe` 里刷新，并通过 `ctx.persistCredentials({ accessToken, refreshToken })`
写回 `.env`（`src/service.ts` 会按账号实际引用的变量名落盘，明文直填的账号会跳过）。

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

调研结论与取舍过程保留在作者本地文档中，不随仓库发布。

---

## 许可

[MIT](LICENSE)

## 免责声明

本项目是本地第三方看板，与各平台官方无关。仅用于查看你本人有权使用的账号；
使用登录态 / 接口取数可能受各平台服务条款约束，请自行确认并承担相应风险。
