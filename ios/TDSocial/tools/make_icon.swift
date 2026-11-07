// Draws the TD Social app icon (1024 x 1024, no transparency, as Apple requires): Antonio's blue TD logo (white mark on blue, tools/td-logo-blue.png)
// enlarged to fill the square, with a small red "social" under it. The blue is sampled from the logo's top-left pixel; the red is the brand red the
// earlier red-on-black icon used (the portal's TD red). iPhone rounds the corners itself, so the square is drawn full-bleed.
// Usage: swift tools/make_icon.swift tools/td-logo-blue.png App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import AppKit
import CoreGraphics

// One colour space for everything (sRGB) so the drawn blue matches the logo's own blue exactly (a generic-RGB fill came out visibly lighter).
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func srgbColor(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor { CGColor(colorSpace: srgb, components: [r, g, b, 1])! }

let args = CommandLine.arguments
guard args.count == 3, let srcImg = NSImage(contentsOfFile: args[1]), let src = srcImg.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("usage: make_icon <td-logo-blue.png> <out.png>") }

let w = src.width, h = src.height
var px = [UInt8](repeating: 0, count: w * h * 4)
let sctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
sctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))

let blue = srgbColor(CGFloat(px[0]) / 255, CGFloat(px[1]) / 255, CGFloat(px[2]) / 255)
let red = srgbColor(216 / 255, 57 / 255, 71 / 255)

// bounding box of the white mark (pixel rows are top-down in this buffer, which is what cropping(to:) expects)
var minX = w, maxX = 0, minY = h, maxY = 0
for y in 0..<h { for x in 0..<w {
    let i = (y * w + x) * 4
    if px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) }
} }
let crop = CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
let mark = src.cropping(to: crop)!

let size = 1024
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.interpolationQuality = .high
ctx.setFillColor(blue); ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

let font = NSFont(name: "HelveticaNeue-BoldItalic", size: 170) ?? NSFont.boldSystemFont(ofSize: 170)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(cgColor: red)!, .kern: 14]
let line = CTLineCreateWithAttributedString(NSAttributedString(string: "social", attributes: attrs))
let tb = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)

let markH: CGFloat = 540
let markW = markH * CGFloat(crop.width) / CGFloat(crop.height)
let gap: CGFloat = 70
let top = (CGFloat(size) + markH + gap + tb.height) / 2      // CoreGraphics origin is bottom-left; the logo + word are centred as one group
ctx.draw(mark, in: CGRect(x: (CGFloat(size) - markW) / 2, y: top - markH, width: markW, height: markH))
ctx.textPosition = CGPoint(x: (CGFloat(size) - tb.width) / 2 - tb.origin.x, y: top - markH - gap - tb.height - tb.origin.y)
CTLineDraw(line, ctx)

try! NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("icon written: blue=\(px[0]),\(px[1]),\(px[2]) mark=\(crop)")
