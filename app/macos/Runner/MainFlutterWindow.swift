import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    // 桌面看板按宽屏布局：默认 1280×860，最小 900×600（低于 900 会切到移动端底栏）。
    self.title = "Power Meter"
    self.setContentSize(NSSize(width: 1280, height: 860))
    self.minSize = NSSize(width: 900, height: 600)
    self.center()
    self.setFrame(self.frame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
