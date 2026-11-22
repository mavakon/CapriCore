// SPDX-License-Identifier: GPL-3.0-only
// Read-only GPU inventory and load from the IOAccelerator registry. Apple
// silicon GPUs share system memory, so no dedicated VRAM is reported (as for a
// shared Windows adapter); only the name, core count and utilization.
import Foundation
import IOKit

private func registryString(_ value: Any?) -> String? {
  if let text = value as? String { return text }
  if let data = value as? Data {
    let text = String(decoding: data.prefix(while: { $0 != 0 }), as: UTF8.self)
    return text.isEmpty ? nil : text
  }
  return nil
}

private func registryNumber(_ value: Any?) -> Double? {
  guard let number = value as? NSNumber, number.doubleValue.isFinite else { return nil }
  return number.doubleValue
}

func gpuInventory() -> [JSON] {
  var iterator: io_iterator_t = 0
  guard
    IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator)
      == KERN_SUCCESS
  else { return [] }
  defer { IOObjectRelease(iterator) }
  var adapters: [JSON] = []
  while adapters.count < 16 {
    let service = IOIteratorNext(iterator)
    if service == 0 { break }
    defer { IOObjectRelease(service) }
    var unmanaged: Unmanaged<CFMutableDictionary>?
    guard IORegistryEntryCreateCFProperties(service, &unmanaged, kCFAllocatorDefault, 0) == KERN_SUCCESS,
      let properties = unmanaged?.takeRetainedValue() as? [String: Any]
    else { continue }
    var entry: UInt64 = 0
    IORegistryEntryGetRegistryEntryID(service, &entry)
    var name = registryString(properties["model"])
    if name == nil {
      var parent: io_registry_entry_t = 0
      if IORegistryEntryGetParentEntry(service, kIOServicePlane, &parent) == KERN_SUCCESS {
        name = registryString(IORegistryEntryCreateCFProperty(parent, "model" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue())
        IOObjectRelease(parent)
      }
    }
    let cleaned = clean(
      String((name ?? "").unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }), 256
    ).trimmingCharacters(in: .whitespaces)
    guard !cleaned.isEmpty else { continue }
    let statistics = properties["PerformanceStatistics"] as? [String: Any] ?? [:]
    var adapter: JSON = [
      "id": "ioreg-" + String(entry), "name": cleaned,
      "vendor": cleaned.hasPrefix("Apple") ? "apple" : cleaned.range(of: "AMD|Radeon", options: .regularExpression) != nil ? "amd" : cleaned.hasPrefix("Intel") ? "intel" : "unknown",
      "memoryKind": cleaned.hasPrefix("Apple") || cleaned.hasPrefix("Intel") ? "shared" : "unknown",
    ]
    if let cores = registryNumber(properties["gpu-core-count"]), cores > 0, cores < 4096 {
      adapter["cores"] = Int(cores)
    }
    if let utilization = registryNumber(statistics["Device Utilization %"]), utilization >= 0,
      utilization <= 100
    {
      adapter["utilization"] = utilization
    }
    if let used = registryNumber(statistics["In use system memory"]), used >= 0 {
      adapter["inUseSystemMemoryBytes"] = Int64(used)
    }
    adapters.append(adapter)
  }
  return adapters
}

func runGpu() -> Int32 {
  Output.line(["adapters": gpuInventory()])
  return 0
}
