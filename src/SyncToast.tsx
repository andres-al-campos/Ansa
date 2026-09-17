/**
 * Says when sync isn't doing its job — in either of the two ways it can fail.
 *
 * They are opposites and the wording has to keep them apart. A dead socket
 * costs this tab *other people's* edits and risks nothing of the user's, so it
 * says changes are still saved. A refused edit is the reverse: everything else
 * works, and one thing the user typed was not stored and is about to vanish
 * when the server's tree is adopted. Telling someone "changes are saved" while
 * one of theirs is being undone would be a lie.
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

export default function SyncToast({
  live,
  rejected,
  rejectedReason,
  onDismissRejected,
}: {
  live: boolean
  /** How many edits the server refused this session. */
  rejected: number
  /** The server's own explanation, when it is one a person can act on. */
  rejectedReason?: string | null
  onDismissRejected: () => void
}) {
  // Dismissal covers the current outage only. A drop after a working period is
  // new information, so recovering re-arms the toast.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (live) setDismissed(false)
  }, [live])

  // A refused edit outranks a dead socket. Deafness costs this tab other
  // people's changes; a rejection means something the user typed is gone, and
  // they are about to watch it disappear when the server's tree is adopted.
  if (rejected > 0) {
    return (
      <div className="sync-toast sync-toast-warn" role="status" aria-live="polite">
        <div className="sync-toast-body">
          <strong className="sync-toast-title">
            {rejected === 1 ? "A change couldn't be saved" : `${rejected} changes couldn't be saved`}
          </strong>
          <p className="sync-toast-text">
            {rejectedReason ??
              `${rejected === 1 ? 'It may have been' : 'They may have been'} an edit to ` +
                'something removed on another device, so it has been undone here. ' +
                'Everything else is saved.'}
          </p>
        </div>
        <button
          type="button"
          className="sync-toast-close"
          onClick={onDismissRejected}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    )
  }

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
