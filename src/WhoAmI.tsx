/**
 * Which account this tab is acting as.
 *
 * Exists because "my projects are gone" and "I'm signed in as an account that
 * isn't the one holding my data" look identical from the app, and while
 * `legacy` and Clerk ids coexist the second is the likelier cause. It reports
 * the ownerId rows are actually filtered on rather than a display name, because
 * the point is to match it against the database.
 *
 * The node count is here for the same reason: 0 nodes under a Clerk id next to
 * 59 under `legacy` is the whole diagnosis, visible without a terminal.
 */

import { useEffect, useState } from 'react'
import { whoami, type WhoAmI } from './api'

export default function WhoAmIPanel() {
  const [me, setMe] = useState<WhoAmI | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void whoami().then((r) => {
      if (cancelled) return
      if (r) setMe(r)
      else setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) {
    return (
      <p className="fine data-note">
        Not signed in — the server rejected this session. Reload to sign in again.
      </p>
    )
  }
  if (!me) return null

  return (
    <div className="whoami">
      <p className="fine data-note">
        Signed in as <code className="whoami-id">{me.ownerId}</code>
        {me.auth === 'dev' && <span className="whoami-tag"> dev stub</span>}
      </p>
      <p className="fine data-note">
        {me.nodes} {me.nodes === 1 ? 'node' : 'nodes'} in this account.
        {me.nodes === 0 && ' An empty account is not the same as missing data — check the id above.'}
      </p>
    </div>
  )
}
