// Draws the TD Social app icon (1024 x 1024, no transparency, as Apple requires): the brand's red "TD" on black. The red and the black are sampled
// from the portal's existing icon (public/portal-icons/icon-512.png) so the app matches the other TD icons.
// Usage: swift tools/make_icon.swift <source icon-512.png> <output icon-1024.png>
import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count == 3, let src = NSImage(contentsOfFile: args[1]), let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("usage: make_icon <in.png> <out.png>") }

// sample: the most saturated red pixel = brand red; the top-left corner pixel = background
let w = cg.width, h = cg.height
var pixels = [UInt8](repeating: 0, count: w * h * 4)
let ctx0 = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx0.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
var best = (r: 200, g: 16, b: 46), bestScore = -1
for i in stride(from: 0, to: pixels.count, by: 4) {
    let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2]), a = Int(pixels[i + 3])
    guard a == 255 else { continue }
    let score = r - max(g, b)
    if score > bestScore { bestScore = score; best = (r, g, b) }
}
let bg = (r: Int(pixels[w * 4 * (h / 2)]) , g: Int(pixels[w * 4 * (h / 2) + 1]), b: Int(pixels[w * 4 * (h / 2) + 2]))   // left edge, middle row
func color(_ c: (r: Int, g: Int, b: Int)) -> CGColor { CGColor(red: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: 1) }

let size = 1024
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(color(bg)); ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
let font = NSFont(name: "HelveticaNeue-BoldItalic", size: 600) ?? NSFont.boldSystemFont(ofSize: 600)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(cgColor: color(best))!]
let text = NSAttributedString(string: "TD", attributes: attrs)
let line = CTLineCreateWithAttributedString(text)
let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
ctx.textPosition = CGPoint(x: (CGFloat(size) - bounds.width) / 2 - bounds.origin.x, y: (CGFloat(size) - bounds.height) / 2 - bounds.origin.y)
CTLineDraw(line, ctx)
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("icon written: red=\(best) background=\(bg)")
