// 화면 캡처(PNG)에서 글자만 읽어 "가운데x 가운데y 글자" 를 위에서 아래 순서로 한 줄씩 낸다.
// 좌표는 캡처 픽셀 기준이라 `adb shell input tap x y` 에 그대로 쓴다.
// 사용: swift screen-text.swift {png 경로}
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write("usage: swift screen-text.swift <png>\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg).perform([request])
let w = Double(cg.width), h = Double(cg.height)
// Vision 좌표는 왼쪽 아래가 원점이고 0~1 비율이다.
let lines = (request.results ?? []).compactMap { o -> (Int, Int, String)? in
    guard let t = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox
    return (Int(b.midX * w), Int((1 - b.midY) * h), t.string)
}
for l in lines.sorted(by: { ($0.1, $0.0) < ($1.1, $1.0) }) { print("\(l.0) \(l.1) \(l.2)") }
