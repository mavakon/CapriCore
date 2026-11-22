// SPDX-License-Identifier: GPL-3.0-only
// Core Audio device listing and capture with the protocol of the Windows
// audio-endpoints helper: `list` prints [{id,kind,label}], `capture <id>` writes
// "CAPRI-AUDIO-1\n" and then 100 ms packets of 16 kHz mono Float32 until stdin
// closes. Inputs are microphones; an output is captured through a private Core
// Audio process tap (macOS 14.2 or later), the counterpart of WASAPI loopback.
import AVFoundation
import CoreAudio
import Foundation

private let sampleRate = 16000.0
private let packetSamples = 1600

private func address(
  _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

private func scalar<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ fallback: T)
  -> T?
{
  var where_ = address(selector)
  var value = fallback
  var size = UInt32(MemoryLayout<T>.size)
  // Only plain numbers are read this way; their bytes are written in place.
  let status = withUnsafeMutableBytes(of: &value) { bytes in
    AudioObjectGetPropertyData(object, &where_, 0, nil, &size, bytes.baseAddress!)
  }
  return status == noErr ? value : nil
}

private func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var where_ = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr, let value
  else { return nil }
  return value.takeRetainedValue() as String
}

private func deviceIds() -> [AudioObjectID] {
  var where_ = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &where_, 0, nil, &size) == noErr, size > 0 else {
    return []
  }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &where_, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

/// Channel count and buffer (stream) count in one direction.
private func streams(_ device: AudioObjectID, _ scope: AudioObjectPropertyScope) -> (
  channels: Int, buffers: Int
) {
  var where_ = address(kAudioDevicePropertyStreamConfiguration, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(device, &where_, 0, nil, &size) == noErr, size > 0 else {
    return (0, 0)
  }
  let raw = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(device, &where_, 0, nil, &size, raw) == noErr else {
    return (0, 0)
  }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return (list.reduce(0) { $0 + Int($1.mNumberChannels) }, list.count)
}

private func channels(_ device: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
  streams(device, scope).channels
}

private let ownPrefix = "com.capri.system-audio."

private struct Endpoint {
  let id: String
  let kind: String
  let label: String
  let device: AudioObjectID
  let uid: String
}

private func endpoints() -> [Endpoint] {
  var result: [Endpoint] = []
  for device in deviceIds() {
    guard let uid = string(device, kAudioDevicePropertyDeviceUID), !uid.hasPrefix(ownPrefix),
      scalar(device, kAudioDevicePropertyDeviceIsAlive, UInt32(0)) == 1
    else { continue }
    let label = string(device, kAudioObjectPropertyName) ?? ""
    if channels(device, kAudioObjectPropertyScopeOutput) > 0 {
      result.append(Endpoint(id: "out:" + uid, kind: "output", label: label, device: device, uid: uid))
    }
    if channels(device, kAudioObjectPropertyScopeInput) > 0 {
      result.append(Endpoint(id: "in:" + uid, kind: "input", label: label, device: device, uid: uid))
    }
  }
  return result
}

/// Mono 16 kHz packets from device buffers at any rate and channel count.
private final class PacketWriter {
  private let converter: AVAudioConverter
  private let input: AVAudioFormat
  private let output: AVAudioFormat
  private var packet = [Float](repeating: 0, count: packetSamples)
  private var used = 0
  private(set) var activity = nowMs()
  /// Leading input streams that are not part of the capture (a system-audio
  /// aggregate lists its clock device's own inputs before the tap).
  private let skipBuffers: Int
  let queue = DispatchQueue(label: "capri.audio.packets")

  init(rate: Double, skipBuffers: Int = 0) throws {
    self.skipBuffers = skipBuffers
    guard rate >= 8000, rate <= 384_000,
      let input = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
      let output = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: input, to: output)
    else { throw HelperError("Audio conversion is unavailable.") }
    converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
    self.converter = converter
    self.input = input
    self.output = output
  }

  /// Averages every channel of every buffer into one mono buffer.
  func mono(_ list: UnsafePointer<AudioBufferList>) -> AVAudioPCMBuffer? {
    let all = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
    let buffers = all.count > skipBuffers ? Array(all.dropFirst(skipBuffers)) : Array(all)
    var frames = Int.max
    var total = 0
    for buffer in buffers where buffer.mNumberChannels > 0 && buffer.mData != nil {
      frames = min(frames, Int(buffer.mDataByteSize) / (4 * Int(buffer.mNumberChannels)))
      total += Int(buffer.mNumberChannels)
    }
    guard total > 0, frames > 0, frames != Int.max,
      let mono = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(frames)),
      let target = mono.floatChannelData?[0]
    else { return nil }
    for index in 0..<frames { target[index] = 0 }
    for buffer in buffers where buffer.mNumberChannels > 0 && buffer.mData != nil {
      let count = Int(buffer.mNumberChannels)
      let samples = buffer.mData!.assumingMemoryBound(to: Float.self)
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<count { sum += samples[frame * count + channel] }
        target[frame] += sum
      }
    }
    let scale = 1 / Float(total)
    for index in 0..<frames {
      let value = target[index] * scale
      target[index] = value.isFinite ? value : 0
    }
    mono.frameLength = AVAudioFrameCount(frames)
    return mono
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    let capacity = AVAudioFrameCount(
      (Double(buffer.frameLength) * sampleRate / input.sampleRate).rounded(.up) + 64)
    guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, let samples = converted.floatChannelData?[0] else { return }
    append(UnsafeBufferPointer(start: samples, count: Int(converted.frameLength)))
    activity = nowMs()
  }

  private func append(_ samples: UnsafeBufferPointer<Float>) {
    for sample in samples {
      packet[used] = sample
      used += 1
      if used == packetSamples { flush() }
    }
  }

  private func flush() {
    let bytes = packet.withUnsafeBufferPointer { Data(buffer: $0) }
    Output.raw(bytes)
    used = 0
  }

  /// An idle tap sends nothing. Advance the detector's clock with silence.
  func idle() {
    if nowMs() - activity < 100 { return }
    for index in used..<packetSamples { packet[index] = 0 }
    flush()
    activity = nowMs()
  }
}

private final class Capture {
  var device: AudioObjectID = 0
  var procedure: AudioDeviceIOProcID?
  var tap: AudioObjectID = 0
  var aggregate: AudioObjectID = 0
  var started = false

  func stop() {
    if started, let procedure { AudioDeviceStop(device, procedure) }
    started = false
    if let procedure { AudioDeviceDestroyIOProcID(device, procedure) }
    procedure = nil
    if aggregate != 0 { AudioHardwareDestroyAggregateDevice(aggregate) }
    aggregate = 0
    if tap != 0, #available(macOS 14.2, *) { AudioHardwareDestroyProcessTap(tap) }
    tap = 0
  }
}

private let capture = Capture()

@available(macOS 14.2, *)
private func systemAudioDevice(_ outputUid: String) throws -> AudioObjectID {
  let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
  description.name = "Capri system audio"
  description.isPrivate = true
  description.muteBehavior = .unmuted
  var tap = AudioObjectID(kAudioObjectUnknown)
  guard AudioHardwareCreateProcessTap(description, &tap) == noErr, tap != kAudioObjectUnknown else {
    throw HelperError("System audio capture is unavailable.")
  }
  capture.tap = tap
  let settings: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Capri system audio",
    kAudioAggregateDeviceUIDKey: ownPrefix + UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUid,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUid]],
    kAudioAggregateDeviceTapListKey: [
      [kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]
    ],
  ]
  var aggregate = AudioObjectID(kAudioObjectUnknown)
  guard AudioHardwareCreateAggregateDevice(settings as CFDictionary, &aggregate) == noErr,
    aggregate != kAudioObjectUnknown
  else { throw HelperError("System audio capture is unavailable.") }
  capture.aggregate = aggregate
  return aggregate
}

private func streamEndpoint(_ id: String) throws -> Never {
  guard let endpoint = endpoints().first(where: { $0.id == id }) else {
    throw HelperError("The selected audio source is unavailable.")
  }
  var device = endpoint.device
  var skipBuffers = 0
  if endpoint.kind == "input" {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .denied || status == .restricted {
      throw HelperError("macOS has not allowed Capri to use the microphone.")
    }
  } else {
    guard #available(macOS 14.2, *) else {
      throw HelperError("Capturing system audio needs macOS 14.2 or later.")
    }
    device = try systemAudioDevice(endpoint.uid)
    skipBuffers = streams(endpoint.device, kAudioObjectPropertyScopeInput).buffers
  }
  capture.device = device
  let rate =
    scalar(device, kAudioDevicePropertyNominalSampleRate, Float64(0))
    .flatMap { $0 > 0 ? $0 : nil } ?? 48000
  let writer = try PacketWriter(rate: rate, skipBuffers: skipBuffers)
  var procedure: AudioDeviceIOProcID?
  let status = AudioDeviceCreateIOProcIDWithBlock(&procedure, device, writer.queue) {
    _, input, _, _, _ in
    if let buffer = writer.mono(input) { writer.write(buffer) }
  }
  guard status == noErr, let procedure else {
    throw HelperError("The selected audio source could not start.")
  }
  capture.procedure = procedure
  Output.raw(Data("CAPRI-AUDIO-1\n".utf8))
  guard AudioDeviceStart(device, procedure) == noErr else {
    throw HelperError("The selected audio source could not start.")
  }
  capture.started = true

  // Runs on the main thread. AudioDeviceStop waits for an IO cycle that runs
  // on the writer queue, so the queue must stay free here.
  let finish = { (code: Int32) in
    capture.stop()
    exit(code)
  }
  for number in [SIGTERM, SIGINT, SIGHUP] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { finish(0) }
    source.resume()
    signals.append(source)
  }
  // Parent death closes the pipe as well, so capture cannot outlive Capri.
  Thread.detachNewThread {
    _ = FileHandle.standardInput.availableData
    DispatchQueue.main.async { finish(0) }
  }
  let watched = endpoint.device
  let timer = DispatchSource.makeTimerSource(queue: writer.queue)
  var checkedAt = nowMs()
  timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
  timer.setEventHandler {
    writer.idle()
    if nowMs() - checkedAt >= 1000 {
      checkedAt = nowMs()
      if scalar(watched, kAudioDevicePropertyDeviceIsAlive, UInt32(0)) != 1 {
        DispatchQueue.main.async { finish(1) }
      }
    }
  }
  timer.resume()
  signals.append(timer)
  dispatchMain()
}

private var signals: [DispatchSourceProtocol] = []

func runAudioEndpoints(_ arguments: [String]) -> Int32 {
  if arguments == ["list"] {
    let list = endpoints().map { ["id": $0.id, "kind": $0.kind, "label": clean($0.label, 180)] }
    Output.line(list)
    return 0
  }
  if arguments.count == 2, arguments[0] == "capture" {
    do { try streamEndpoint(arguments[1]) } catch {
      capture.stop()
      FileHandle.standardError.write(Data("Core Audio capture unavailable\n".utf8))
      return 1
    }
  }
  return 2
}
