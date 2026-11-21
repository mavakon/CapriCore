// SPDX-License-Identifier: GPL-3.0-only
// Spotify desktop control through its AppleScript interface, with the request
// and result protocol of the Windows bridge. Only playback controls that
// Spotify scripts can verify are offered; search, liked songs, queue and library
// browsing report that they are not available on macOS yet. Never launches
// Spotify, never reads credentials and never changes other applications.
import AppKit
import Foundation

private let spotifyBundle = "com.spotify.client"

private struct SpotifyError: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

private func spotifyRunning() -> Bool {
  !NSRunningApplication.runningApplications(withBundleIdentifier: spotifyBundle).isEmpty
}

/// Runs AppleScript against Spotify only while it is already running. The guard
/// inside the script keeps a quit-in-between from relaunching it.
private func script(_ body: String) throws -> NSAppleEventDescriptor {
  guard spotifyRunning() else {
    throw SpotifyError(
      "player_not_ready", "Spotify is not running. Open it and sign in, then retry the command.")
  }
  let source =
    "if application id \"\(spotifyBundle)\" is running then\n"
    + "tell application id \"\(spotifyBundle)\"\n\(body)\nend tell\nelse\nreturn \"not-running\"\nend if"
  guard let compiled = NSAppleScript(source: source) else {
    throw SpotifyError("macos_bridge_error", "The Spotify control script could not be prepared.")
  }
  var info: NSDictionary?
  let result = compiled.executeAndReturnError(&info)
  if let info {
    let number = (info[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
    if number == -1743 || number == -1744 {
      throw SpotifyError(
        "automation_denied",
        "macOS has not allowed Capri to control Spotify. Allow it in System Settings → Privacy & Security → Automation, then retry."
      )
    }
    if number == -600 || number == -609 {
      throw SpotifyError(
        "player_not_ready", "Spotify is not running. Open it and sign in, then retry the command.")
    }
    throw SpotifyError(
      "spotify_rejected",
      "Spotify did not accept this command; it may be unavailable during an advert or on this device.")
  }
  if result.stringValue == "not-running" {
    throw SpotifyError(
      "player_not_ready", "Spotify is not running. Open it and sign in, then retry the command.")
  }
  return result
}

private func item(_ list: NSAppleEventDescriptor, _ index: Int) -> NSAppleEventDescriptor? {
  index <= list.numberOfItems ? list.atIndex(index) : nil
}

private func string(_ value: NSAppleEventDescriptor?) -> String {
  clean(value?.stringValue, 300)
}

private func double(_ value: NSAppleEventDescriptor?) -> Double? {
  guard let value else { return nil }
  if let number = value.coerce(toDescriptorType: typeIEEE64BitFloatingPoint) {
    var result: Double = 0
    (number.data as NSData).getBytes(&result, length: MemoryLayout<Double>.size)
    return result.isFinite ? result : nil
  }
  return value.stringValue.flatMap(Double.init)
}

private func status() throws -> JSON {
  var state: JSON = ["running": spotifyRunning(), "provider": "macos-desktop"]
  guard spotifyRunning() else { return state }
  let list = try script(
    """
    set playerState to player state as string
    set volumeLevel to sound volume
    set shuffleState to shuffling
    set repeatState to repeating
    set position to player position
    set trackName to ""
    set trackArtist to ""
    set trackAlbum to ""
    set trackDuration to 0
    set trackId to ""
    try
      set trackName to name of current track
      set trackArtist to artist of current track
      set trackAlbum to album of current track
      set trackDuration to duration of current track
      set trackId to id of current track
    end try
    return {playerState, volumeLevel, shuffleState, repeatState, position, trackName, trackArtist, trackAlbum, trackDuration, trackId}
    """)
  guard list.numberOfItems == 10 else {
    throw SpotifyError("player_not_ready", "Spotify's player state is not available yet.")
  }
  let playerState = string(item(list, 1))
  state["playing"] = playerState == "playing"
  if let volume = double(item(list, 2)) {
    state["volumePercent"] = Int(volume.rounded())
    state["muted"] = volume == 0
  }
  state["shuffle"] = item(list, 3)?.booleanValue ?? false
  state["repeat"] = item(list, 4)?.booleanValue == true ? "list" : "none"
  if playerState != "stopped" {
    state["title"] = string(item(list, 6))
    state["artist"] = string(item(list, 7))
    state["album"] = string(item(list, 8))
    if let position = double(item(list, 5)) { state["positionMs"] = Int64(position * 1000) }
    if let duration = double(item(list, 9)) { state["durationMs"] = Int64(duration) }
    state["canSeek"] = true
    state["trackUri"] = string(item(list, 10))
  }
  state["source"] = "spotify-applescript"
  return state
}

private func settle(_ check: (JSON) -> Bool, timeoutMs: Double = 2500) throws -> JSON? {
  let began = nowMs()
  repeat {
    sleepMs(150)
    let state = try status()
    if check(state) { return state }
  } while nowMs() - began < timeoutMs
  return nil
}

private func playing(_ state: JSON) -> Bool { state["playing"] as? Bool == true }

private func transport(_ action: String) throws -> JSON {
  let before = try status()
  if action == "resume" && playing(before) { return before }
  if action == "pause" && before["playing"] as? Bool == false { return before }
  let command =
    ["resume": "play", "pause": "pause", "toggle": "playpause", "next": "next track"][action]
    ?? "previous track"
  _ = try script(command)
  let verified = try settle { state in
    switch action {
    case "pause": return !playing(state)
    case "resume": return playing(state)
    case "toggle": return playing(state) != playing(before)
    default:
      return state["trackUri"] as? String != before["trackUri"] as? String
        || (state["positionMs"] as? Int64 ?? 0) < (before["positionMs"] as? Int64 ?? 0)
    }
  }
  guard let verified else {
    throw SpotifyError(
      "not_verified",
      "Spotify did not confirm the command. Check for an advert or a client/account restriction before retrying."
    )
  }
  return verified
}

private var volumeBeforeMute: Int?

private func setVolume(_ target: Int) throws -> JSON {
  _ = try script("set sound volume to \(target)")
  // Spotify rounds some levels down by one.
  guard
    let state = try settle({ state in
      guard let volume = state["volumePercent"] as? Int else { return false }
      return abs(volume - target) <= 2
    }, timeoutMs: 1200)
  else {
    throw SpotifyError("not_verified", "Spotify volume did not reach the requested level.")
  }
  return state
}

private func requestNumber(_ q: JSON, _ key: String, _ low: Double, _ high: Double) throws -> Double {
  guard let value = number(q, key), value >= low, value <= high else {
    throw SpotifyError("invalid_request", "Invalid Spotify command.")
  }
  return value
}

private func requestBool(_ q: JSON, _ key: String) throws -> Bool {
  guard let value = bool(q, key) else {
    throw SpotifyError("invalid_request", "Invalid Spotify command.")
  }
  return value
}

private let unavailable = SpotifyError(
  "unsupported",
  "This Spotify action is not available on macOS yet. Play, pause, skip, volume, seek, shuffle, repeat and Spotify links work."
)

private func normalizedUri(_ raw: String) -> String? {
  let pattern = "^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{22}$"
  return matches(raw, pattern) ? raw : nil
}

private func execute(_ q: JSON) throws -> Any {
  let action = text(q, "action")
  switch action {
  case "status": return try status()
  case "resume", "pause", "toggle", "next", "previous": return try transport(action)
  case "volume":
    let current = try status()
    guard let volume = current["volumePercent"] as? Int else {
      throw SpotifyError("audio_session_unavailable", "Spotify did not report its volume.")
    }
    let target =
      q["delta"] != nil
      ? max(0, min(100, volume + Int(try requestNumber(q, "delta", -100, 100).rounded())))
      : Int(try requestNumber(q, "value", 0, 100).rounded())
    return try setVolume(target)
  case "mute":
    let enabled = try requestBool(q, "enabled")
    let current = try status()
    let volume = current["volumePercent"] as? Int ?? 0
    if enabled {
      if volume == 0 { return current }
      volumeBeforeMute = volume
      return try setVolume(0)
    }
    if volume > 0 { return current }
    let restored = volumeBeforeMute ?? 50
    volumeBeforeMute = nil
    return try setVolume(restored)
  case "seek":
    let seconds = try requestNumber(q, "seconds", 0, 86400)
    let current = try status()
    guard current["positionMs"] != nil else {
      throw SpotifyError("unsupported", "Start a track in Spotify before seeking.")
    }
    _ = try script("set player position to \(seconds)")
    guard
      let state = try settle({ state in
        guard let position = state["positionMs"] as? Int64 else { return false }
        return abs(Double(position) - seconds * 1000) <= 2000
      })
    else {
      throw SpotifyError("not_verified", "Spotify did not confirm the requested playback position.")
    }
    return state
  case "shuffle":
    let enabled = try requestBool(q, "enabled")
    _ = try script("set shuffling to \(enabled)")
    guard let state = try settle({ $0["shuffle"] as? Bool == enabled }) else {
      throw SpotifyError("not_verified", "Spotify did not confirm the shuffle setting.")
    }
    return state
  case "repeat":
    let mode = text(q, "mode")
    guard ["off", "context", "track"].contains(mode) else {
      throw SpotifyError("invalid_request", "Repeat mode must be off, context or track.")
    }
    if mode == "track" {
      throw SpotifyError(
        "unsupported", "Spotify on macOS can repeat the whole album or playlist, not one track.")
    }
    _ = try script("set repeating to \(mode == "context")")
    let expected = mode == "off" ? "none" : "list"
    guard let state = try settle({ $0["repeat"] as? String == expected }) else {
      throw SpotifyError("not_verified", "Spotify did not confirm the repeat setting.")
    }
    return state
  case "play":
    let raw = text(q, "uri")
    if raw.isEmpty { throw unavailable }
    guard let uri = normalizedUri(raw), !text(q, "resourceTitle").isEmpty else {
      throw SpotifyError(
        "invalid_request", "Spotify link metadata is missing. Use the song title and artist instead.")
    }
    let track = uri.hasPrefix("spotify:track:")
    let before = try status()
    _ = try script("play track \"\(uri)\"")
    guard
      let state = try settle(
        { state in
          playing(state)
            && (track
              ? state["trackUri"] as? String == uri
              : state["trackUri"] as? String != before["trackUri"] as? String || !playing(before))
        }, timeoutMs: 6000)
    else {
      throw SpotifyError(
        "not_verified",
        "Spotify did not start the selected music. Check for an advert or a client/account restriction before retrying."
      )
    }
    return state
  case "search", "liked_songs", "queue", "queue_add", "library": throw unavailable
  default: throw SpotifyError("invalid_request", "Unknown Spotify action.")
  }
}

func runSpotify() -> Int32 {
  Output.line(["type": "ready", "protocol": 1])
  while let line = readLine(strippingNewline: true) {
    if line.utf8.count > 16384 { return 0 }
    var id: Any = NSNull()
    do {
      let request = try parseObject(line)
      id = request["request"] ?? NSNull()
      let data = try execute(request)
      Output.line(["type": "result", "request": id, "ok": true, "data": data])
    } catch let error as SpotifyError {
      Output.line([
        "type": "result", "request": id, "ok": false,
        "error": ["code": error.code, "message": error.message],
      ])
    } catch {
      Output.line([
        "type": "result", "request": id, "ok": false,
        "error": [
          "code": "macos_bridge_error",
          "message":
            "The Spotify macOS control could not complete. Check the app and retry the command yourself.",
        ],
      ])
    }
  }
  return 0
}
