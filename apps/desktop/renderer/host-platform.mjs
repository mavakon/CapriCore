// SPDX-License-Identifier: GPL-3.0-only
/** The renderer's view of the host, for platform-specific guidance only. */
export function macHost(host = globalThis.navigator) {
  return /^mac/i.test(String(host?.userAgentData?.platform ?? host?.platform ?? ''));
}

const WINDOWS_MICROPHONE_DENIED =
  'Microphone access was denied. Check Windows microphone access for desktop apps.';
export const MAC_MICROPHONE_DENIED =
  'Microphone access was denied. Allow Capri in System Settings → Privacy & Security → Microphone.';

export function microphoneDeniedMessage(host) {
  return macHost(host) ? MAC_MICROPHONE_DENIED : WINDOWS_MICROPHONE_DENIED;
}
