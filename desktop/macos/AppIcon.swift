import AppKit

/**
 * 构建期生成 App 图标：1024×1024 PNG。
 * 只依赖 AppKit，不需要设计资源文件；build 脚本再用 sips/iconutil 转 .icns。
 */

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
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

// 1. 圆角底板（macOS 图标安全区留 34pt）
let inset: CGFloat = 34
let plate = NSBezierPath(
    roundedRect: NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2),
    xRadius: 226,
    yRadius: 226
)
NSGradient(colors: [color(18, 40, 40), color(6, 12, 18)])?.draw(in: plate, angle: -90)

// 2. 顶部微光
NSGraphicsContext.saveGraphicsState()
plate.addClip()
NSGradient(colors: [color(74, 222, 168, 0.18), color(74, 222, 168, 0.0)])?.draw(
    in: NSRect(x: 90, y: 600, width: 940, height: 430),
    relativeCenterPosition: NSPoint(x: 0.12, y: 0.5)
)
NSGraphicsContext.restoreGraphicsState()

// 3. 表盘底环
let center = NSPoint(x: s / 2, y: s / 2 + 10)
let ringRadius: CGFloat = 292
let ringWidth: CGFloat = 62
let ring = NSBezierPath()
ring.appendArc(withCenter: center, radius: ringRadius, startAngle: 0, endAngle: 360)
ring.lineWidth = ringWidth
color(255, 255, 255, 0.075).setStroke()
ring.stroke()

// 4. 进度弧（底部留开口，像仪表盘）
let arc = NSBezierPath()
arc.appendArc(withCenter: center, radius: ringRadius, startAngle: -18, endAngle: 205, clockwise: false)
arc.lineWidth = ringWidth
arc.lineCapStyle = .round
if let arcGradient = NSGradient(colors: [color(96, 165, 250), color(74, 222, 168)]) {
    arcGradient.draw(in: arc, angle: 35)
} else {
    color(74, 222, 168).setStroke()
    arc.stroke()
}

// 5. 闪电（品牌主体）
let bolt = NSBezierPath()
bolt.move(to: NSPoint(x: 566, y: 812))
bolt.line(to: NSPoint(x: 382, y: 498))
bolt.line(to: NSPoint(x: 512, y: 498))
bolt.line(to: NSPoint(x: 448, y: 236))
bolt.line(to: NSPoint(x: 666, y: 566))
bolt.line(to: NSPoint(x: 532, y: 566))
bolt.close()

NSGraphicsContext.saveGraphicsState()
graphics.cgContext.setShadow(
    offset: CGSize(width: 0, height: -10),
    blur: 34,
    color: color(74, 222, 168, 0.45).cgColor
)
color(233, 255, 246).setFill()
bolt.fill()
NSGraphicsContext.restoreGraphicsState()

// 6. 开口两侧的小刻度，增加「仪表」语义
let tickAngles: [CGFloat] = [-18, 205]
for angle in tickAngles {
    let radians = angle * .pi / 180
    let inner = NSPoint(x: center.x + cos(radians) * (ringRadius - 46),
                        y: center.y + sin(radians) * (ringRadius - 46))
    let outer = NSPoint(x: center.x + cos(radians) * (ringRadius + 46),
                        y: center.y + sin(radians) * (ringRadius + 46))
    let tick = NSBezierPath()
    tick.move(to: inner)
    tick.line(to: outer)
    tick.lineWidth = 14
    tick.lineCapStyle = .round
    color(233, 255, 246, 0.55).setStroke()
    tick.stroke()
}

NSGraphicsContext.restoreGraphicsState()

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