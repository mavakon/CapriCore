// SPDX-License-Identifier: GPL-3.0-only
/**
 * macOS microphone privacy (TCC). The system asks the user once; afterwards
 * Chromium's getUserMedia succeeds or fails with NotAllowedError, which the
 * renderer reports with the macOS settings path. Asking from the main process
 * shows the prompt before capture starts instead of failing silently.
 * Other platforms keep their existing permission flow unchanged.
 */
/**
 * Resolves to true when microphone access is granted (or not governed by TCC
 * on this platform) and false when the user or a policy has denied it.
 */
export async function requestMicrophoneAccess({ platform = process.platform, preferences } = {}) {
  if (platform !== 'darwin') return true;
  if (!preferences?.getMediaAccessStatus) return false;
  let status;
  try {
    status = preferences.getMediaAccessStatus('microphone');
  } catch {
    return false;
  }
  if (status === 'granted') return true;
  // 'denied' and 'restricted' (parental or device management) need System Settings.
  if (status !== 'not-determined' && status !== 'unknown') return false;
  try {
    return (await preferences.askForMediaAccess('microphone')) === true;
  } catch {
    return false;
  }
}
