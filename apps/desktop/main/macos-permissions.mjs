// SPDX-License-Identifier: GPL-3.0-only
/**
 * macOS privacy permissions for computer control. macOS grants them to the app
 * that started Capri: Capri.app when installed, or the terminal that ran
 * `npm run desktop` from source. Checking never changes a setting; when one is
 * missing, macOS is asked to show its own prompt, and the owner decides there.
 */
export const ACCESSIBILITY_REQUIRED =
  'macOS has not allowed Capri to control the computer. Turn on Capri (or, when running from source, the terminal app that started it) in System Settings → Privacy & Security → Accessibility, then ask again. No input was sent.';

export class MacosComputerPermissions {
  constructor({
    systemPreferences,
    requestScreenRecording = async () => {},
    platform = process.platform,
  }) {
    Object.assign(this, { systemPreferences, requestScreenRecording, platform });
    this.screenRequested = false;
  }

  status() {
    if (this.platform !== 'darwin') return { accessibility: true, screenRecording: true };
    return {
      accessibility: this.systemPreferences.isTrustedAccessibilityClient(false) === true,
      screenRecording: this.systemPreferences.getMediaAccessStatus('screen') === 'granted',
    };
  }

  /** Null when computer control may start, otherwise the error to report. */
  check() {
    if (this.platform !== 'darwin') return null;
    const { accessibility, screenRecording } = this.status();
    if (!screenRecording && !this.screenRequested) {
      // Screenshots are optional for control (Accessibility is enough), so a
      // missing Screen Recording grant only asks once and does not block.
      this.screenRequested = true;
      void Promise.resolve()
        .then(() => this.requestScreenRecording())
        .catch(() => {});
    }
    if (accessibility) return null;
    // Shows the system prompt the first time; later calls only report.
    this.systemPreferences.isTrustedAccessibilityClient(true);
    return Object.assign(new Error(ACCESSIBILITY_REQUIRED), {
      code: 'COMPUTER_ACCESSIBILITY_REQUIRED',
      inputPerformed: false,
    });
  }
}
