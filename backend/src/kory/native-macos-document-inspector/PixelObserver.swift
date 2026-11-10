import AppKit
import Foundation

// Independent image probe for PNGs returned by macOS screencapture. It does
// not render UI, infer layout from fixture state or forge missing pixels.
struct ImageObservation: Codable {
    let pixelsWide: Int
    let pixelsHigh: Int
    let sampledPoints: Int
    let distinctColors: Int
    let luminanceRange: Double
    let meanLuminance: Double
    let meanReferenceDifference: Double?
}

func loadImage(_ path: String) -> NSBitmapImageRep {
    guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let image = NSBitmapImageRep(data: bytes),
          image.pixelsWide > 0, image.pixelsHigh > 0 else {
        fputs("Unable to decode a real PNG: \(path)\n", stderr)
        exit(2)
    }
    return image
}

func channels(_ image: NSBitmapImageRep, _ x: Int, _ y: Int) -> [Double] {
    guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
        fputs("Pixel sampling failed\n", stderr)
        exit(3)
    }
    return [Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent)]
}

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
    fputs("Usage: PixelObserver <native-window.png> [approved-reference.png]\n", stderr)
    exit(2)
}

let screenshot = loadImage(CommandLine.arguments[1])
let reference = CommandLine.arguments.count == 3 ? loadImage(CommandLine.arguments[2]) : nil
if let reference = reference,
   (reference.pixelsWide != screenshot.pixelsWide || reference.pixelsHigh != screenshot.pixelsHigh) {
    fputs("Reference image dimensions differ from matching-condition capture\n", stderr)
    exit(4)
}

var colors = Set<String>()
var brightest = 0.0
var darkest = 1.0
var luminositySum = 0.0
var samples = 0
var differenceSum = 0.0
let strideX = max(1, screenshot.pixelsWide / 80)
let strideY = max(1, screenshot.pixelsHigh / 80)
for y in Swift.stride(from: 0, to: screenshot.pixelsHigh, by: strideY) {
    for x in Swift.stride(from: 0, to: screenshot.pixelsWide, by: strideX) {
        let rgb = channels(screenshot, x, y)
        let luminosity = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        brightest = max(brightest, luminosity)
        darkest = min(darkest, luminosity)
        luminositySum += luminosity
        colors.insert(rgb.map { String(Int($0 * 32)) }.joined(separator: ":"))
        if let reference = reference {
            let previous = channels(reference, x, y)
            differenceSum += zip(rgb, previous).map { abs($0 - $1) }.reduce(0, +) / 3
        }
        samples += 1
    }
}

let result = ImageObservation(
    pixelsWide: screenshot.pixelsWide,
    pixelsHigh: screenshot.pixelsHigh,
    sampledPoints: samples,
    distinctColors: colors.count,
    luminanceRange: brightest - darkest,
    meanLuminance: luminositySum / Double(samples),
    meanReferenceDifference: reference == nil ? nil : differenceSum / Double(samples)
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
guard let data = try? encoder.encode(result), let json = String(data: data, encoding: .utf8) else {
    fputs("Pixel summary serialization failed\n", stderr)
    exit(5)
}
print(json)
