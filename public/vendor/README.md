# public/vendor

看板前端用到的第三方代码，均以**单文件、零构建**形式直接由后端静态托管。

## qrcode.js

| 项 | 说明 |
| --- | --- |
| 用途 | 「扫码登录」弹窗里把 `authUrl` 画成本地二维码（canvas），不调用任何在线二维码服务 |
| 来源 | [`qrcode-terminal@0.12.0`](https://www.npmjs.com/package/qrcode-terminal) 内置的 `vendor/QRCode/*` |
| 上游实现 | Kazuhiko Arase，<http://www.d-project.com/> |
| 许可 | MIT，Copyright (c) 2009 Kazuhiko Arase |
| 引入方式 | 文件直接放在 `public/vendor/`，**不进入 `package.json`**，运行时依赖仍为零 |

### 改造点

1. 把上游 10 个 CommonJS 文件（`QR8bitByte` / `QRBitBuffer` / `QRErrorCorrectLevel` / `QRMaskPattern` / `QRMath` / `QRMode` / `QRPolynomial` / `QRRSBlock` / `QRUtil` / `index`）合并为一个 IIFE，挂到 `window.QRCode`；
2. 只保留 8-bit byte 模式（登录链接是 URL，不需要数字 / 字母数字 / 汉字模式）；
3. 删除 Flash 时代的 `createMovieClip`、`createTableTag`、`createSvgTag` 等未使用代码；
4. 追加 `QRCode.toCanvas(canvas, text, options)`：自动选版本、画 4 模块静区、按 `devicePixelRatio` 缩放；
5. 算法（RS 分块表、纠错多项式、掩码评分、数据排布）逐字保留，已用 3 组 URL（含 501 字符的 Trae 登录链接）与原实现逐模块比对，输出完全一致。

### 使用约束

- `QR8bitByte.write` 用 `charCodeAt` 逐字符写入 8 bit，**只支持 ASCII**；传入前请用 `encodeURIComponent`（登录链接本身就是 ASCII URL）。
- 编码失败（链接过长）时 `QRCode.toCanvas` 返回 `false`，调用方应降级为「可点击链接 + 复制」。
