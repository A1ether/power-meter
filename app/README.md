# Power Meter · Flutter 客户端

多平台 AI 余额看板的 Flutter 实现，一套 Dart 代码产出 Web / macOS / iOS / Android。

## 结构

```
lib/
├── main.dart                 # 启动：加载设置、决定后端连接方式
├── app.dart                  # MaterialApp、双主题、启动门（错误 / 连接 / 看板）
├── core/
│   ├── api/api_client.dart   # /api/* 封装、令牌与 Intent 头、错误归一
│   ├── models/               # 与 src/types.ts 对应的手写模型 + 纯函数派生逻辑
│   ├── format/               # 数字 / 日期 / 过期文案口径
│   ├── theme/                # Material 3 深 / 浅主题、语义色
│   └── platform/             # 运行形态、macOS sidecar、本地设置
├── state/providers.dart      # Riverpod：快照、刷新、排序筛选、主题
└── features/
    ├── shell/                # 导航、顶栏、命令面板、设置
    ├── dashboard/            # 总览、卡片、时间线、诊断
    └── accounts/             # 平台与账号、登录、凭证表单、密钥
```

## 运行

```bash
# 先启动 Node 后端（仓库根目录）
npm run dev

# Web（同源，无需令牌）
flutter run -d chrome

# macOS 桌面（开发态回退到 127.0.0.1:48213）
flutter run -d macos

# 移动端：首次启动填写服务地址与令牌（只读看板）
flutter run -d ios
```

## 校验

```bash
flutter analyze
flutter test
```

构建与打包见仓库根目录 `README.md` 的「Flutter 客户端」一节。
