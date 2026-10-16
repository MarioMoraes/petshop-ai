// ocr.swift · OCR do macOS (Vision) com as caixas de cada linha de texto, em JSON.
// uso:  swift scripts/ocr.swift img1.png img2.png > caixas.json
//       (o periciar.py compila uma vez em build/ocr com swiftc e chama o binário)
// saída: { "caminho": { "w": W, "h": H, "caixas": [ {x, y, w, h, texto, conf}, ... ] } }
//        x, y em pixels a partir do canto superior esquerdo; h é a altura da linha reconhecida.
import Foundation
import Vision
import AppKit

var tudo: [String: Any] = [:]
for caminho in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: caminho),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("ERR \(caminho)\n".data(using: .utf8)!)
        continue
    }
    let W = CGFloat(cg.width), H = CGFloat(cg.height)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["pt-BR", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    var caixas: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let c = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox   // normalizado, origem embaixo à esquerda
        caixas.append([
            "x": Double(b.minX * W), "y": Double((1 - b.maxY) * H),
            "w": Double(b.width * W), "h": Double(b.height * H),
            "texto": c.string, "conf": Double(c.confidence)
        ])
    }
    caixas.sort { (a, b) -> Bool in
        let ya = a["y"] as! Double, yb = b["y"] as! Double
        if abs(ya - yb) > 12 { return ya < yb }
        return (a["x"] as! Double) < (b["x"] as! Double)
    }
    tudo[caminho] = ["w": Int(W), "h": Int(H), "caixas": caixas]
}
let data = try! JSONSerialization.data(withJSONObject: tudo, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
