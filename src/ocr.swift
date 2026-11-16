// ocr.swift — native macOS Vision OCR for LINE window screenshots.
// Reads an image path (arg 1), prints recognized text lines top-to-bottom,
// left-to-right. No third-party dependencies — uses the system Vision
// framework. `yarn build` compiles it once with the SYSTEM swiftc (not
// swiftly) to dist/ocr; interpreting it with `swift` costs ~3 s per call.
//
//   dist/ocr /path/to/image.png [--crop left,top,right,bottom] [--boxes]
//
// --crop takes window fractions (0..1, top-left origin) and replaces the old
// Python/Pillow crop step.
// Languages tuned for LINE in Taiwan: Traditional/Simplified Chinese, English,
// Japanese. Adjust recognitionLanguages if your chats use other scripts.

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: ocr.swift <image-path>\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("ERR: cannot load image at \(path)\n".data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
var image = cg
if let i = args.firstIndex(of: "--crop") {
    let f = i + 1 < args.count ? args[i + 1].split(separator: ",").compactMap { Double($0) } : []
    guard f.count == 4, f[0] >= 0, f[1] >= 0, f[2] <= 1, f[3] <= 1, f[2] > f[0], f[3] > f[1] else {
        FileHandle.standardError.write("ERR: --crop needs left,top,right,bottom fractions\n".data(using: .utf8)!)
        exit(2)
    }
    let w = Double(cg.width), h = Double(cg.height)
    let rect = CGRect(x: (f[0] * w).rounded(), y: (f[1] * h).rounded(),
                      width: ((f[2] - f[0]) * w).rounded(), height: ((f[3] - f[1]) * h).rounded())
    guard let c = cg.cropping(to: rect) else {
        FileHandle.standardError.write("ERR: crop failed\n".data(using: .utf8)!)
        exit(1)
    }
    image = c
}

let boxes = args.contains("--boxes")
let bitmap = boxes ? NSBitmapImageRep(cgImage: image) : nil

// Only yellow/orange search highlighting is accepted. Other themes fail closed.
func highlighted(_ rect: CGRect) -> Bool {
    guard let bitmap = bitmap else { return false }
    let x0 = max(0, Int(rect.minX * Double(image.width)))
    let x1 = min(image.width, Int(rect.maxX * Double(image.width)))
    let y0 = max(0, Int((1 - rect.maxY) * Double(image.height)))
    let y1 = min(image.height, Int((1 - rect.minY) * Double(image.height)))
    guard x1 > x0, y1 > y0 else { return false }
    var count = 0
    for y in y0..<y1 {
        for x in x0..<x1 {
            if let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
               c.redComponent > 0.7, c.greenComponent > 0.4,
               c.blueComponent < 0.45, c.redComponent >= c.greenComponent * 0.9 {
                count += 1
            }
        }
    }
    return Double(count) / Double((x1 - x0) * (y1 - y0)) >= 0.15
}

let req = VNRecognizeTextRequest { request, _ in
    guard let obs = request.results as? [VNRecognizedTextObservation] else { return }
    // Reading order: top-to-bottom by line, then left-to-right within a line.
    let sorted = obs.sorted { a, b in
        if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01 {
            return a.boundingBox.midY > b.boundingBox.midY
        }
        return a.boundingBox.midX < b.boundingBox.midX
    }
    if boxes {
        let rows: [[String: Any]] = sorted.compactMap { o in
            guard let t = o.topCandidates(1).first else { return nil }
            let r = o.boundingBox
            return ["text": t.string, "confidence": Double(t.confidence),
                    "x": Double(r.minX), "y": Double(1 - r.maxY),
                    "width": Double(r.width), "height": Double(r.height),
                    "highlighted": highlighted(r)]
        }
        if let data = try? JSONSerialization.data(withJSONObject: rows),
           let json = String(data: data, encoding: .utf8) { print(json) }
    } else {
        for o in sorted {
            if let t = o.topCandidates(1).first { print(t.string) }
        }
    }
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hant", "zh-Hans", "en", "ja"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("ERR: OCR failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
