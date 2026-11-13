/** Browser tab / system-browser handoff for one ParkWise OAuth attempt. */

import type { ParkwiseAttemptId, ParkwiseStatusView } from '@deepseek-ai/dsh-parkwise-connector/types'

/**
 * Coordinates opening the ParkWise OAuth authorize URL across Web browsers (using a
 * pre-opened blank tab to bypass async popup blockers) and Desktop (opening the URL via
 * `window.open(..., '_blank', 'noopener,noreferrer')`, which Electron forwards to the OS browser).
 */
export class ParkwiseBrowserLogin {
  private popup: Window | null = null
  private navigated = false
  private attemptId: ParkwiseAttemptId | undefined

  /** @param desktop - true when running inside Electron Desktop (`'dshDesktop' in globalThis`). */
  constructor(private readonly desktop: boolean) {}

  /**
   * Begin an OAuth sign-in flow inside the user's click gesture and follow the resulting attempt.
   * @param request - Host RPC starting the OAuth attempt.
   * @param latest - latest streamed snapshot (in case stream delivers authorizeUrl before RPC resolves).
   */
  async start(request: () => Promise<ParkwiseStatusView>, latest: () => ParkwiseStatusView | undefined): Promise<void> {
    if (!this.desktop) this.preopenTab()
    try {
      const initial = await request()
      this.attemptId = initial.attempt?.id
      this.update(initial)
      this.update(latest())
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  private preopenTab(): void {
    this.dispose()
    this.popup = window.open('about:blank', '_blank')
    if (this.popup !== null) this.popup.opener = null
  }

  /**
   * Synchronize opened tab state when a new Host snapshot arrives.
   * @param view - latest ParkWise snapshot from Host.
   */
  update(view: ParkwiseStatusView | undefined): void {
    const attempt = view?.attempt
    if (attempt === null || attempt === undefined || attempt.id !== this.attemptId) return
    if (['failed', 'expired', 'cancelled'].includes(attempt.phase)) {
      this.dispose()
      return
    }
    if (attempt.phase === 'succeeded') {
      if (!this.navigated) this.popup?.close()
      this.popup = null
      this.attemptId = undefined
      this.navigated = false
      return
    }
    if (!attempt.authorizeUrl || this.navigated) return
    this.navigated = true
    if (this.desktop) {
      window.open(attempt.authorizeUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (this.popup !== null && !this.popup.closed) {
      this.popup.location.replace(attempt.authorizeUrl)
    }
  }

  /** Close any pending Web popup tab and reset navigation tracking. */
  dispose(): void {
    this.popup?.close()
    this.popup = null
    this.attemptId = undefined
    this.navigated = false
  }
}
