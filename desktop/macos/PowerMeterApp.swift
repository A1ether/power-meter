import Cocoa
import WebKit

/**
 * Power Meter · macOS 桌面外壳
 *
 * 职责边界：
 *   1. 在 ~/Library/Application Support/PowerMeter/ 落首次启动配置；
 *   2. 拉起 App 内自带的 bun sidecar（--port 0 随机端口、--static-dir 指向 Resources/public）；
 *   3. 从 sidecar 的稳定就绪行解析真实端口，用 WKWebView 加载看板；
 *   4. 管理窗口 / 菜单 / 日志 / 退出时的子进程回收。
 *
 * 看板本身仍是仓库里的 Node 兼容服务（src/server.ts），这里不复制任何业务逻辑。
 */
private let kAppName = "Power Meter"

@main
struct PowerMeterMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    // 路径
    private let configDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("PowerMeter", isDirectory: true)
    }()
    private let logsDir: URL = {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library")
        return base.appendingPathComponent("Logs/PowerMeter", isDirectory: true)
    }()
    private var logURL: URL { logsDir.appendingPathComponent("server.log") }

    // 窗口与网页
    private var window: NSWindow!
    private var webView: WKWebView!
    private var overlay: NSView!
    private var overlayTitle: NSTextField!
    private var overlayDetail: NSTextField!
    private var spinner: NSProgressIndicator!
    private var retryButton: NSButton!
    private var helpWindow: NSWindow?

    // 子进程
    private var process: Process?
    private var stdoutPipe: Pipe?
    private var outputBuffer = ""
    private var serverPort: Int?
    private var serverURL: URL?
    private var isTerminating = false
    private var logHandle: FileHandle?

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        let firstRun = !FileManager.default.fileExists(atPath: configDir.appendingPathComponent("accounts.json").path)
        prepareDirectories()
        openLogFile()
        buildMenu()
        buildWindow()
        startServer()
        if firstRun {
            // 第一次打开：给一份本地说明，不弹网页、不联网。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.showHelp(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        guard let child = process, child.isRunning else { return }
        child.terminate()
        let deadline = Date().addingTimeInterval(2)
        while child.isRunning && Date() < deadline { usleep(50_000) }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }

    // MARK: - 配置

    private func prepareDirectories() {
        let fm = FileManager.default
        try? fm.createDirectory(at: configDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: logsDir, withIntermediateDirectories: true)

        // 只落模板，不覆盖用户已有配置。
        let accounts = configDir.appendingPathComponent("accounts.json")
        if !fm.fileExists(atPath: accounts.path),
           let seed = Bundle.main.url(forResource: "accounts.template", withExtension: "json", subdirectory: "seed") {
            try? fm.copyItem(at: seed, to: accounts)
        }

        let env = configDir.appendingPathComponent(".env")
        if !fm.fileExists(atPath: env.path),
           let seedEnv = Bundle.main.url(forResource: "env", withExtension: "template", subdirectory: "seed") {
            try? fm.copyItem(at: seedEnv, to: env)
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
        }
    }

    private func openLogFile() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: logURL.path) {
            fm.createFile(atPath: logURL.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: logURL)
        _ = try? logHandle?.seekToEnd()
        let stamp = ISO8601DateFormatter().string(from: Date())
        appendLog("\n===== Power Meter launch \(stamp) =====\n")
    }

    private func appendLog(_ text: String) {
        if let data = text.data(using: .utf8) { logHandle?.write(data) }
    }

    // MARK: - 服务进程

    private func startServer() {
        guard let resources = Bundle.main.resourceURL else {
            showFailure("找不到 App 资源目录。")
            return
        }
        let sidecar = resources.appendingPathComponent("power-meter-sidecar")
        let publicDir = resources.appendingPathComponent("public")
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: sidecar.path) else {
            showFailure("内置服务文件缺失或不可执行：\n\(sidecar.path)")
            return
        }
        guard fm.fileExists(atPath: publicDir.appendingPathComponent("index.html").path) else {
            showFailure("看板静态资源缺失：\n\(publicDir.path)/index.html")
            return
        }

        let child = Process()
        child.executableURL = sidecar
        child.currentDirectoryURL = configDir

        var env = ProcessInfo.processInfo.environment
        // 显式环境变量优先于 .env（Node 与 Bun 都是这个优先级），避免配置目录与 cwd 不一致。
        env["ACCOUNTS_PATH"] = configDir.appendingPathComponent("accounts.json").path
        env["PORT"] = "0"
        env["HOST"] = "127.0.0.1"
        child.environment = env
        child.arguments = [
            "--port", "0",
            "--host", "127.0.0.1",
            "--config-dir", configDir.path,
            "--static-dir", publicDir.path,
        ]

        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = pipe
        stdoutPipe = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            guard let text = String(data: data, encoding: .utf8) else { return }
            self?.appendLog(text)
            DispatchQueue.main.async { self?.consumeOutput(text) }
        }

        child.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.isTerminating else { return }
                if self.serverPort == nil {
                    self.showFailure("内置服务未能启动（退出状态 \(proc.terminationStatus)）。")
                } else {
                    self.showFailure("内置服务已退出（状态 \(proc.terminationStatus)）。点「重试」可重新启动。")
                }
            }
        }

        do {
            try child.run()
        } catch {
            showFailure("无法启动内置服务：\(error.localizedDescription)")
            return
        }
        process = child
        appendLog("spawned sidecar pid=\(child.processIdentifier) cwd=\(configDir.path)\n")

        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            // 进程已经退出时交给 terminationHandler 报具体原因，别用「超时」覆盖它。
            guard let self, self.serverPort == nil, self.process?.isRunning == true else { return }
            self.showFailure("内置服务启动超时（30 秒）。\n请查看日志确认端口或依赖问题。")
        }
    }

    private func stopServer() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        guard let child = process, child.isRunning else { return }
        child.terminate()
        let deadline = Date().addingTimeInterval(1.5)
        while child.isRunning && Date() < deadline { usleep(50_000) }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        process = nil
    }

    private func consumeOutput(_ text: String) {
        outputBuffer += text
        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[outputBuffer.startIndex..<newline])
            outputBuffer = String(outputBuffer[outputBuffer.index(after: newline)...])
            if serverPort == nil, let url = parseReadyURL(from: line) {
                handleReady(url)
            }
        }
        if outputBuffer.count > 64_000 {
            outputBuffer = String(outputBuffer.suffix(4_096))
        }
    }

    /// 解析 sidecar 的稳定就绪行：`[power-meter] listening at http://127.0.0.1:<port> ...`
    private func parseReadyURL(from line: String) -> URL? {
        guard let marker = line.range(of: "listening at ") else { return nil }
        let rest = line[marker.upperBound...]
        guard let token = rest.split(separator: " ").first, token.hasPrefix("http://") else { return nil }
        return URL(string: String(token))
    }

    private func handleReady(_ url: URL) {
        guard let port = url.port else { return }
        serverPort = port
        serverURL = url
        appendLog("server ready at \(url.absoluteString)\n")
        overlay?.isHidden = true
        webView.load(URLRequest(url: url))
        window.title = "\(kAppName) · 本地看板"
    }

    // MARK: - 界面

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = kAppName
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(calibratedRed: 0.031, green: 0.043, blue: 0.063, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: frame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = window.backgroundColor
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        let content = NSView(frame: frame)
        content.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        content.addSubview(buildOverlay(frame: frame))
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildOverlay(frame: NSRect) -> NSView {
        let container = NSView(frame: frame)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(calibratedRed: 0.031, green: 0.043, blue: 0.063, alpha: 1).cgColor
        overlay = container

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isIndeterminate = true
        spinner.startAnimation(nil)

        overlayTitle = NSTextField(labelWithString: "正在启动本地看板…")
        overlayTitle.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        overlayTitle.textColor = NSColor(calibratedWhite: 0.93, alpha: 1)

        overlayDetail = NSTextField(wrappingLabelWithString: "首次启动会初始化配置目录，通常只需几秒。")
        overlayDetail.font = NSFont.systemFont(ofSize: 13)
        overlayDetail.textColor = NSColor(calibratedWhite: 0.62, alpha: 1)
        overlayDetail.alignment = .center
        overlayDetail.maximumNumberOfLines = 0
        overlayDetail.preferredMaxLayoutWidth = 560

        retryButton = NSButton(title: "重试", target: self, action: #selector(retryServer(_:)))
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true

        let buttons = NSStackView(views: [retryButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10

        stack.addArrangedSubview(spinner)
        stack.addArrangedSubview(overlayTitle)
        stack.addArrangedSubview(overlayDetail)
        stack.addArrangedSubview(buttons)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 640),
        ])
        return container
    }

    private func showFailure(_ message: String) {
        DispatchQueue.main.async {
            self.spinner?.stopAnimation(nil)
            self.spinner?.isHidden = true
            self.overlayTitle?.stringValue = "看板启动失败"
            self.overlayDetail?.stringValue = "\(message)\n\n日志：\(self.logURL.path)"
            self.retryButton?.isHidden = false
            self.overlay?.isHidden = false
        }
    }

    @objc private func retryServer(_ sender: Any?) {
        spinner.isHidden = false
        spinner.startAnimation(nil)
        overlayTitle.stringValue = "正在重新启动本地看板…"
        overlayDetail.stringValue = "旧进程会被结束，配置不会丢失。"
        retryButton.isHidden = true
        serverPort = nil
        stopServer()
        outputBuffer = ""
        startServer()
    }

    // MARK: - 菜单

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: kAppName)
        appMenu.addItem(withTitle: "关于 \(kAppName)", action: #selector(showAbout(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "打开配置目录", action: #selector(openConfigDir(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "打开日志", action: #selector(openLog(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(kAppName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        for item in editMenu.items { item.target = nil }
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadDashboard(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        let external = NSMenuItem(title: "在浏览器中打开", action: #selector(openInBrowser(_:)), keyEquivalent: "O")
        external.keyEquivalentModifierMask = [.command, .shift]
        external.target = self
        viewMenu.addItem(external)
        viewMenu.addItem(.separator())
        let help = NSMenuItem(title: "使用说明", action: #selector(showHelp(_:)), keyEquivalent: "?")
        help.target = self
        viewMenu.addItem(help)
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func showAbout(_ sender: Any?) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
        let alert = NSAlert()
        alert.messageText = "\(kAppName) \(version)"
        alert.informativeText = """
        多平台 AI 余额 / 积分看板 · 本地优先

        配置目录：
        \(configDir.path)

        当前服务：
        \(serverURL?.absoluteString ?? "未启动")

        看板数据直接来自各平台接口，凭证只保存在本机。
        """
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "打开配置目录")
        if alert.runModal() == .alertSecondButtonReturn {
            openConfigDir(nil)
        }
    }

    @objc private func openConfigDir(_ sender: Any?) {
        NSWorkspace.shared.open(configDir)
    }

    @objc private func openLog(_ sender: Any?) {
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        NSWorkspace.shared.activateFileViewerSelecting([logURL])
    }

    @objc private func reloadDashboard(_ sender: Any?) {
        if let url = serverURL {
            webView.load(URLRequest(url: url))
        } else {
            retryServer(nil)
        }
    }

    @objc private func openInBrowser(_ sender: Any?) {
        if let url = serverURL { NSWorkspace.shared.open(url) }
    }

    @objc private func showHelp(_ sender: Any?) {
        if let existing = helpWindow {
            existing.makeKeyAndOrderFront(nil)
            return
        }
        guard let url = Bundle.main.url(forResource: "help", withExtension: "html") else {
            let alert = NSAlert()
            alert.messageText = "使用说明缺失"
            alert.informativeText = "App 资源里找不到 help.html。"
            alert.runModal()
            return
        }
        let frame = NSRect(x: 0, y: 0, width: 820, height: 760)
        let win = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "\(kAppName) · 使用说明"
        win.minSize = NSSize(width: 560, height: 480)
        win.isReleasedWhenClosed = false
        let view = WKWebView(frame: frame)
        view.autoresizingMask = [.width, .height]
        win.contentView = view
        win.center()
        helpWindow = win
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        win.makeKeyAndOrderFront(nil)
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    // 把加载结果写进日志，出问题时不必盲猜（ATS / 端口 / 静态资源都能在这里看到）。
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        appendLog("webview didFinish \(webView.url?.absoluteString ?? "")\n")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        appendLog("webview didFail \(error.localizedDescription)\n")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        appendLog("webview didFailProvisional \(error.localizedDescription)\n")
        showFailure("看板页面加载失败：\(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if isLocal(url) {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, !isLocal(url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func isLocal(_ url: URL) -> Bool {
        guard url.scheme == "http" else { return false }
        guard url.host == "127.0.0.1" || url.host == "localhost" else { return false }
        if let port = serverPort { return url.port == port }
        return true
    }

    // 看板里的少量 window.alert / confirm 也要有响应，否则按钮看起来「没反应」。
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}