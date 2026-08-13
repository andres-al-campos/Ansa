/**
 * Says when this tab has stopped receiving other people's edits.
 *
 * Exists because a broken live connection is invisible: writes go over HTTP and
 * keep working, so the app looks healthy while silently missing every change
 * made elsewhere. Two tabs drift apart and whoever wrote last appears to win.
 * That is exactly how a uBlock rule against workers.dev cost an afternoon —
 * nothing in the UI suggested the socket had never once connected.
 *
 * A toast rather than a banner: the outliner still works, and reflowing the
 * tree for a condition someone may rationally ignore is too loud. It floats,
 * costs no layout, and persists rather than auto-hiding, because the condition
 * itself is ongoing.
 *
 * The causes are offered, not asserted. From the browser a blocked socket, a
 * proxy that strips upgrades, and a captive network look identical — naming the
 * ad blocker as *the* cause would send everyone else chasing the wrong fix.
 */

import { useEffect, useState } from 'react'

export default function SyncToast({ live }: { live: boolean }) {
  // Dismissal covers the current outage only. A drop after a working period is
  // new information, so recovering re-arms the toast.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (live) setDismissed(false)
  }, [live])

  if (live || dismissed) return null

  return (
    <div className="sync-toast" role="status" aria-live="polite">
      <div className="sync-toast-body">
        <strong className="sync-toast-title">Not syncing</strong>
        <p className="sync-toast-text">
          Changes are saved, but this tab won't see edits made elsewhere. An ad blocker, VPN, or
          restrictive network can block the live connection.
        </p>
      </div>
      <button
        type="button"
        className="sync-toast-close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
