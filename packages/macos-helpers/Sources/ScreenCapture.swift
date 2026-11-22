// SPDX-License-Identifier: GPL-3.0-only
// Screen frames through ScreenCaptureKit, with the same binary worker protocol
// and one-shot output as the Windows capture-display.ps1. Coordinates are global
// top-left points (the space Electron and Accessibility use on macOS), and a
// frame is never larger than its bounds in points. Errors carry no titles,
// coordinates or pixels.
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Runs an asynchronous ScreenCaptureKit call to completion on this thread.
private func waitFor<T>(
  _ timeout: Double = 5000, _ start: (@escaping (T?, Error?) -> Void) -> Void
) throws -> T {
  let lock = NSLock()
  var result: T?
  var failed: Error?
  var done = false
  start { value, error in
    lock.lock()
    result = value
    failed = error
    done = true
    lock.unlock()
  }
  let began = nowMs()
  while true {
    lock.lock()
    let finished = done
    lock.unlock()
    if finished { break }
    if nowMs() - began > timeout { throw HelperError("Screen capture timed out.") }
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
  }
  if let failed { throw failed }
  guard let result else { throw HelperError("Screen capture is unavailable.") }
  return result
}

private var cachedContent: (at: Double, content: SCShareableContent)?

private func shareableContent(fresh: Bool) throws -> SCShareableContent {
  if !fresh, let cached = cachedContent, nowMs() - cached.at < 1000 { return cached.content }
  let content: SCShareableContent = try waitFor { done in
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { value, error in
      done(value, error)
    }
  }
  cachedContent = (nowMs(), content)
  return content
}

private func checkSize(_ width: Int, _ height: Int) throws {
  if width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 40_000_000 {
    throw HelperError("Display exceeds limits")
  }
}

private func scDisplay(containing area: CGRect) throws -> SCDisplay {
  for fresh in [false, true] {
    let content = try shareableContent(fresh: fresh)
    if let display = content.displays.first(where: { $0.frame.contains(area) }) { return display }
  }
  throw HelperError("The requested region is outside its display")
}

private func configuration(_ width: Int, _ height: Int) -> SCStreamConfiguration {
  let config = SCStreamConfiguration()
  config.width = width
  config.height = height
  config.showsCursor = false
  config.pixelFormat = kCVPixelFormatType_32BGRA
  config.colorSpaceName = CGColorSpace.sRGB
  config.scalesToFit = true
  return config
}

private func screenshot(_ filter: SCContentFilter, _ config: SCStreamConfiguration) throws -> CGImage {
  try waitFor { done in
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
      done(image, error)
    }
  }
}

/// A BGRA canvas of exactly the frame size, top-down rows, opaque.
private final class Canvas {
  let width: Int
  let height: Int
  let context: CGContext
  init(_ width: Int, _ height: Int) throws {
    self.width = width
    self.height = height
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { throw HelperError("Capture surface unavailable") }
    self.context = context
    context.interpolationQuality = .high
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  }
  /// Draws `image` into a rectangle given in top-left canvas coordinates.
  func draw(_ image: CGImage, in rect: CGRect, clip: CGRect? = nil) {
    let flipped = CGRect(
      x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height)
    context.saveGState()
    if let clip {
      context.clip(
        to: CGRect(x: clip.minX, y: CGFloat(height) - clip.maxY, width: clip.width, height: clip.height))
    }
    context.draw(image, in: flipped)
    context.restoreGState()
  }
  func bgra() throws -> Data {
    guard let base = context.data else { throw HelperError("Capture surface unavailable") }
    var pixels = Data(bytes: base, count: width * height * 4)
    pixels.withUnsafeMutableBytes { buffer in
      let bytes = buffer.bindMemory(to: UInt8.self)
      var index = 3
      while index < bytes.count {
        bytes[index] = 255
        index += 4
      }
    }
    return pixels
  }
  func png() throws -> Data {
    guard let image = context.makeImage() else { throw HelperError("Capture surface unavailable") }
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.png.identifier as CFString, 1, nil)
    else { throw HelperError("Capture encoding unavailable") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw HelperError("Capture encoding unavailable")
    }
    return data as Data
  }
}

/// The display that holds the foreground window (or, with no window in front,
/// the pointer). With `displayWindow` the foreground window must be that one.
private func foregroundArea(displayWindow: String) throws -> CGRect {
  let front = foregroundWindowNumber()
  if !displayWindow.isEmpty {
    guard let window = front?.window, String(window) == displayWindow else {
      throw HelperError("The foreground window changed before capture")
    }
  }
  if let window = front?.window, let info = windowInfo(window), let screen = display(for: info.bounds)
  {
    return screen.bounds
  }
  if !displayWindow.isEmpty { throw HelperError("No foreground window") }
  let pointer = CGEvent(source: nil)?.location ?? .zero
  if let screen = displays().first(where: { $0.bounds.contains(pointer) }) { return screen.bounds }
  return CGDisplayBounds(CGMainDisplayID())
}

/// A window this helper's owner (Capri) created, for generated verification fixtures.
private func ownedArea(_ id: String) throws -> CGRect {
  guard let number = UInt32(id), let info = windowInfo(number), info.pid == getppid() else {
    throw HelperError("Fixture unavailable")
  }
  return info.bounds.integral
}

private struct Frame {
  var area: CGRect
  var width: Int
  var height: Int
  var bytes: Data
}

private func frameSize(_ area: CGRect, _ maxWidth: Int, _ maxHeight: Int) throws -> (Int, Int) {
  try checkSize(Int(area.width), Int(area.height))
  if maxWidth <= 0 || maxWidth > 16384 || maxHeight <= 0 || maxHeight > 16384 {
    throw HelperError("Invalid frame size")
  }
  let scale = min(1, min(Double(maxWidth) / area.width, Double(maxHeight) / area.height))
  return (
    max(1, Int((area.width * scale).rounded(.toNearestOrAwayFromZero))),
    max(1, Int((area.height * scale).rounded(.toNearestOrAwayFromZero)))
  )
}

private func captureRegion(_ area: CGRect, _ width: Int, _ height: Int) throws -> Canvas {
  let display = try scDisplay(containing: area)
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let config = configuration(width, height)
  config.sourceRect = area.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
  let image = try screenshot(filter, config)
  let canvas = try Canvas(width, height)
  canvas.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return canvas
}

/// One window's own pixels (even where covered), placed where it overlaps `area`.
private func captureWindowRegion(_ identity: String, _ area: CGRect, _ width: Int, _ height: Int)
  throws -> Canvas
{
  let parts = identity.split(separator: ":")
  guard parts.count == 2, let number = UInt32(parts[0]), let pid = pid_t(parts[1]) else {
    throw HelperError("Invalid window identity")
  }
  guard let before = windowInfo(number), before.pid == pid, before.alpha > 0 else {
    throw HelperError("The selected window client is unavailable")
  }
  let content = try shareableContent(fresh: true)
  guard
    let window = content.windows.first(where: {
      $0.windowID == number && $0.owningApplication?.processID == pid && $0.isOnScreen
    })
  else { throw HelperError("The selected window client is unavailable") }
  let frame = before.bounds
  try checkSize(Int(frame.width), Int(frame.height))
  let overlap = frame.intersection(area)
  if overlap.isNull || overlap.width < 1 || overlap.height < 1 {
    throw HelperError("The window left the capture region")
  }
  let sx = Double(width) / area.width
  let sy = Double(height) / area.height
  let config = configuration(
    max(1, Int((frame.width * sx).rounded())), max(1, Int((frame.height * sy).rounded())))
  let image = try screenshot(SCContentFilter(desktopIndependentWindow: window), config)
  guard let after = windowInfo(number), after.bounds == frame else {
    throw HelperError("The window moved during capture")
  }
  let canvas = try Canvas(width, height)
  let place = { (rect: CGRect) in
    CGRect(
      x: (rect.minX - area.minX) * sx, y: (rect.minY - area.minY) * sy, width: rect.width * sx,
      height: rect.height * sy)
  }
  canvas.draw(image, in: place(frame), clip: place(overlap))
  return canvas
}

private func readFrame(_ line: String) throws -> Frame {
  let args = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
  if args.count != 9 { throw HelperError("Invalid capture request") }
  var area: CGRect
  switch args[0] {
  case "region", "window-region":
    guard let x = Int(args[2]), let y = Int(args[3]), let w = Int(args[4]), let h = Int(args[5])
    else { throw HelperError("Invalid capture request") }
    try checkSize(w, h)
    area = CGRect(x: x, y: y, width: w, height: h)
    guard displays().contains(where: { $0.bounds.contains(area) }) else {
      throw HelperError("The requested region is outside its display")
    }
  case "foreground": area = try foregroundArea(displayWindow: args[1])
  case "owned": area = try ownedArea(args[1])
  default: throw HelperError("Invalid capture source")
  }
  area = area.integral
  guard let maxWidth = Int(args[6]), let maxHeight = Int(args[7]) else {
    throw HelperError("Invalid frame size")
  }
  let (width, height) = try frameSize(area, maxWidth, maxHeight)
  let canvas =
    args[0] == "window-region"
    ? try captureWindowRegion(args[1], area, width, height)
    : try captureRegion(area, width, height)
  return Frame(
    area: area, width: width, height: height,
    bytes: args[8] == "png" ? try canvas.png() : try canvas.bgra())
}

private func int32(_ value: Int) -> Data {
  var little = Int32(truncatingIfNeeded: value).littleEndian
  return Data(bytes: &little, count: 4)
}

/// Serial frames: one `mode|handle|x|y|w|h|maxW|maxH|format` line in, one
/// 32-byte little-endian header (status, bounds, frame size, byte count) plus
/// the image out.
func runScreenWorker() -> Int32 {
  setpriority(PRIO_PROCESS, 0, 5)
  while let line = readLine(strippingNewline: true) {
    var header = Data()
    var body = Data()
    if line.utf8.count <= 512, let frame = try? readFrame(line) {
      header.append(int32(0))
      for value in [frame.area.minX, frame.area.minY, frame.area.width, frame.area.height] {
        header.append(int32(Int(value)))
      }
      header.append(int32(frame.width))
      header.append(int32(frame.height))
      header.append(int32(frame.bytes.count))
      body = frame.bytes
    } else {
      header.append(int32(1))
      for _ in 0..<7 { header.append(int32(0)) }
    }
    Output.raw(header + body)
  }
  return 0
}

/// One-shot capture of the active display at its size in points:
/// base64 PNG, or `{x,y,width,height[,png]}` with --probe / --with-geometry.
func runScreenCapture(_ arguments: [String]) -> Int32 {
  var owned = ""
  var displayWindow = ""
  var probe = false
  var geometry = false
  var index = 0
  while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--owned-window", "--display-window":
      guard index + 1 < arguments.count, matches(arguments[index + 1], "^[0-9]{1,20}$") else {
        FileHandle.standardError.write(Data("Invalid capture arguments.\n".utf8))
        return 2
      }
      if argument == "--owned-window" { owned = arguments[index + 1] } else {
        displayWindow = arguments[index + 1]
      }
      index += 2
    case "--probe":
      probe = true
      index += 1
    case "--with-geometry":
      geometry = true
      index += 1
    default:
      FileHandle.standardError.write(Data("Invalid capture arguments.\n".utf8))
      return 2
    }
  }
  do {
    let area = (owned.isEmpty ? try foregroundArea(displayWindow: displayWindow) : try ownedArea(owned))
      .integral
    let width = Int(area.width)
    let height = Int(area.height)
    try checkSize(width, height)
    let bounds: JSON = [
      "x": Int(area.minX), "y": Int(area.minY), "width": width, "height": height,
    ]
    if probe {
      Output.raw(Output.data(bounds))
      return 0
    }
    let png = try captureRegion(area, width, height).png().base64EncodedString()
    if geometry {
      var value = bounds
      value["png"] = png
      Output.raw(Output.data(value))
    } else {
      Output.raw(Data(png.utf8))
    }
    return 0
  } catch {
    FileHandle.standardError.write(Data("macOS could not capture the active display.\n".utf8))
    return 1
  }
}
