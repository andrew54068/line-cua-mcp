// ocr.swift — native macOS Vision OCR for LINE window screenshots.
// Reads an image path (arg 1), prints recognized text lines top-to-bottom,
// left-to-right. No third-party dependencies — uses the system Vision
// framework. Run with the SYSTEM swift (/usr/bin/swift), not swiftly.
//
//   /usr/bin/swift ocr.swift /path/to/image.png
//
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

let req = VNRecognizeTextRequest { request, _ in
    guard let obs = request.results as? [VNRecognizedTextObservation] else { return }
    // Reading order: top-to-bottom by line, then left-to-right within a line.
    let sorted = obs.sorted { a, b in
        if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01 {
            return a.boundingBox.midY > b.boundingBox.midY
        }
        return a.boundingBox.midX < b.boundingBox.midX
    }
    for o in sorted {
        if let t = o.topCandidates(1).first { print(t.string) }
    }
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hant", "zh-Hans", "en", "ja"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("ERR: OCR failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
