import AppKit
import ImageIO

/**
 * 构建期生成 App 图标：1024×1024 PNG。
 *
 * 产品语义（Power Meter · 多平台 AI 额度看板）：
 *   - 深色圆弧底板 = 仪表盘 / 电量表
 *   - 五段渐变色弧 = 多个平台的额度环，一眼看出「多平台聚合」
 *   - 中央闪电 = Power；白色高光保证 16pt 下仍是清晰剪影
 * 只依赖 AppKit，不需要设计资源文件；build 脚本再用 sips/iconutil 转 .icns。
 */

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
/** `--square`：输出铺满画布的不透明方图，供 iOS / Android 使用（系统自己切圆角） */
let square = CommandLine.arguments.contains("--square")
let side = 1024
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: side,
    pixelsHigh: side,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    FileHandle.standardError.write("cannot allocate bitmap\n".data(using: .utf8)!)
    exit(1)
}
rep.size = NSSize(width: side, height: side)

guard let graphics = NSGraphicsContext(bitmapImageRep: rep) else {
    FileHandle.standardError.write("no graphics context\n".data(using: .utf8)!)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.imageInterpolation = .high
graphics.shouldAntialias = true
graphics.cgContext.setAllowsAntialiasing(true)
graphics.cgContext.setShouldAntialias(true)

let s = CGFloat(side)

// ---------------------------------------------------------------- 1. 圆角底板
// Apple macOS 图标网格：1024 画布上主题体约 824–840，四周留白 + 投影。
// iOS / Android 用 --square：满幅不透明，由系统切圆角。
let inset: CGFloat = square ? 0 : 92
let corner: CGFloat = square ? 0 : 188
let plateRect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
let plate = NSBezierPath(roundedRect: plateRect, xRadius: corner, yRadius: corner)

if !square {
    NSGraphicsContext.saveGraphicsState()
    let plateShadow = NSShadow()
    plateShadow.shadowColor = NSColor.black.withAlphaComponent(0.5)
    plateShadow.shadowBlurRadius = 42
    plateShadow.shadowOffset = NSSize(width: 0, height: -18)
    plateShadow.set()
    color(6, 12, 20).setFill()
    plate.fill()
    NSGraphicsContext.restoreGraphicsState()
}

guard let plateGradient = NSGradient(colors: [
    color(16, 43, 58),   // #102B3A 顶部：深海蓝绿
    color(7, 14, 24),    // #070E18 底部：近黑
]) else {
    FileHandle.standardError.write("gradient failed\n".data(using: .utf8)!)
    exit(1)
}
plateGradient.draw(in: plate, angle: -90)

NSGraphicsContext.saveGraphicsState()
plate.addClip()

// 两处柔光直接铺满整个底板再裁切，避免渐变矩形在图标中部留下横向接缝
NSGradient(colors: [color(56, 189, 248, 0.20), color(56, 189, 248, 0.0)])?.draw(
    in: plateRect,
    relativeCenterPosition: NSPoint(x: 0.18, y: 0.62)
)

// 底部青绿反光：呼应「电量 / 额度」的品牌色
NSGradient(colors: [color(45, 212, 191, 0.18), color(45, 212, 191, 0.0)])?.draw(
    in: plateRect,
    relativeCenterPosition: NSPoint(x: -0.15, y: -0.45)
)
NSGraphicsContext.restoreGraphicsState()

// 内描边：图标边缘的细亮线（方图满幅时不需要）
if !square {
    let edge = NSBezierPath(roundedRect: plateRect.insetBy(dx: 1.5, dy: 1.5), xRadius: corner - 2, yRadius: corner - 2)
    edge.lineWidth = 3
    color(255, 255, 255, 0.10).setStroke()
    edge.stroke()
}

// ---------------------------------------------------------------- 2. 仪表弧
let center = NSPoint(x: s / 2, y: s / 2 + 8)
let radius: CGFloat = 286
let ringWidth: CGFloat = 66
let sweep: CGFloat = 270          // 底部留 90° 开口
let segments = 5
let gap: CGFloat = 7              // 段间空隙（角度），保证小尺寸下仍能看出分段
let segSweep = (sweep - gap * CGFloat(segments - 1)) / CGFloat(segments)

// 弧底光晕
NSGraphicsContext.saveGraphicsState()
let arcGlow = NSBezierPath()
arcGlow.appendArc(withCenter: center, radius: radius, startAngle: 225, endAngle: -45, clockwise: true)
arcGlow.lineWidth = ringWidth + 18
arcGlow.lineCapStyle = .round
let glowShadow = NSShadow()
glowShadow.shadowColor = color(45, 212, 191, 0.45)
glowShadow.shadowBlurRadius = 46
glowShadow.set()
color(45, 212, 191, 0.22).setStroke()
arcGlow.stroke()
NSGraphicsContext.restoreGraphicsState()

// 五段平台色：薄荷 → 青 → 蓝 → 靛 → 琥珀（末段暗示「到期提醒」）
let palette: [NSColor] = [
    color(45, 212, 191),   // mint
    color(56, 189, 248),   // sky
    color(99, 102, 241),   // indigo
    color(168, 85, 247),   // purple
    color(251, 191, 36),   // amber
]

var angle = CGFloat(225)
for (index, tint) in palette.enumerated() {
    let seg = NSBezierPath()
    seg.appendArc(withCenter: center, radius: radius, startAngle: angle, endAngle: angle - segSweep, clockwise: true)
    seg.lineWidth = ringWidth
    seg.lineCapStyle = .round

    NSGraphicsContext.saveGraphicsState()
    let segShadow = NSShadow()
    segShadow.shadowColor = tint.withAlphaComponent(index == palette.count - 1 ? 0.5 : 0.35)
    segShadow.shadowBlurRadius = 20
    segShadow.shadowOffset = NSSize(width: 0, height: 0)
    segShadow.set()
    tint.setStroke()
    seg.stroke()
    NSGraphicsContext.restoreGraphicsState()

    angle -= segSweep + gap
}

// 弧内侧细环：增强「表盘」层次
let innerRing = NSBezierPath()
innerRing.appendArc(withCenter: center, radius: radius - ringWidth / 2 - 22,
                    startAngle: 225, endAngle: -45, clockwise: true)
innerRing.lineWidth = 3
innerRing.lineCapStyle = .round
color(255, 255, 255, 0.10).setStroke()
innerRing.stroke()

// ---------------------------------------------------------------- 3. 中央闪电
NSGraphicsContext.saveGraphicsState()
NSGradient(colors: [color(52, 211, 153, 0.30), color(52, 211, 153, 0.0)])?.draw(
    in: NSBezierPath(ovalIn: NSRect(x: 512 - 238, y: 508 - 238, width: 476, height: 476)),
    relativeCenterPosition: .zero
)

let bolt = NSBezierPath()
bolt.move(to: NSPoint(x: 530, y: 674))
bolt.line(to: NSPoint(x: 424, y: 492))
bolt.line(to: NSPoint(x: 499, y: 492))
bolt.line(to: NSPoint(x: 462, y: 340))
bolt.line(to: NSPoint(x: 588, y: 531))
bolt.line(to: NSPoint(x: 511, y: 531))
bolt.close()

let boltShadow = NSShadow()
boltShadow.shadowColor = color(45, 212, 191, 0.65)
boltShadow.shadowBlurRadius = 38
boltShadow.shadowOffset = NSSize(width: 0, height: -8)
boltShadow.set()
color(240, 253, 250).setFill()
bolt.fill()
NSGraphicsContext.restoreGraphicsState()

// 闪电上的冷白高光
NSGraphicsContext.saveGraphicsState()
bolt.addClip()
NSGradient(colors: [color(255, 255, 255, 0.35), color(255, 255, 255, 0.0)])?.draw(
    in: NSRect(x: 430, y: 490, width: 170, height: 190),
    angle: -60
)
NSGraphicsContext.restoreGraphicsState()

// ---------------------------------------------------------------- 4. 底部「到期」标记
// 开口中央（仪表弧的零点）放一颗琥珀色小圆点：像表盘上的警示灯，提示「最快到期」
let alertDot = NSBezierPath(ovalIn: NSRect(x: 512 - 17, y: 512 - 286 - 17, width: 34, height: 34))
NSGraphicsContext.saveGraphicsState()
let dotShadow = NSShadow()
dotShadow.shadowColor = color(251, 191, 36, 0.8)
dotShadow.shadowBlurRadius = 26
dotShadow.set()
color(251, 191, 36).setFill()
alertDot.fill()
NSGraphicsContext.restoreGraphicsState()

NSGraphicsContext.restoreGraphicsState()

if square {
    // iOS 图标不允许带 alpha 通道：把满幅 RGBA 图重绘到 RGB(X) 上下文再导出
    guard let cg = rep.cgImage else {
        FileHandle.standardError.write("flatten failed\n".data(using: .utf8)!)
        exit(1)
    }
    guard let ctx = CGContext(
        data: nil,
        width: side,
        height: side,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else {
        FileHandle.standardError.write("flatten context failed\n".data(using: .utf8)!)
        exit(1)
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
    guard let flat = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: outPath) as CFURL,
            "public.png" as CFString,
            1,
            nil
          ) else {
        FileHandle.standardError.write("flatten failed\n".data(using: .utf8)!)
        exit(1)
    }
    CGImageDestinationAddImage(dest, flat, nil)
    guard CGImageDestinationFinalize(dest) else {
        FileHandle.standardError.write("png encode failed\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}

guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("png encode failed\n".data(using: .utf8)!)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}