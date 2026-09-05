/**
 * The trash: what was deleted, with a way to put it back.
 *
 * Its own component and its own fetch rather than something carried in the
 * tree. The trash is opened rarely and grows without bound between sweeps, while
 * every edit already reads the whole tree — so it stays off that path, which is
 * the reason the server stores it in separate tables at all.
 *
 * Loads when opened, not on mount. A sidebar section nobody expands should cost
 * no requests.
 */

import { useCallback, useEffect, useState } from 'react'
import { fetchTrash, forgetTrash, restoreTrash, type TrashEntry } from './api'
import type { Tree } from '@shared/tree'

/** "3 days ago" — coarse on purpose; the exact minute of a deletion is noise. */
function ago(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/**
 * How much longer this entry has. The sweep runs daily past 30 days, so the
 * number is what the user can still act on rather than a precise deadline.
 */
function left(at: number): string {
  const days = 30 - Math.floor((Date.now() - at) / 86_400_000)
  return days <= 1 ? 'goes today' : `${days} days left`
}

export default function TrashPanel({
  tree,
  onRestored,
}: {
  tree: Tree
  onRestored: (tree: Tree) => void
}) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `more` appends rather than replacing, so paging never loses what is on
  // screen. The cursor is a timestamp rather than an offset, so a sweep running
  // between two pages cannot shift the window and skip an entry.
  const load = useCallback(async (after?: number) => {
    setBusy(true)
    setError(null)
    try {
      const page = await fetchTrash(after)
      setEntries((prev) => (after === undefined ? page.entries : [...(prev ?? []), ...page.entries]))
      setCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the trash.')
    } finally {
      setBusy(false)
    }
  }, [])

  async function restore(entry: TrashEntry) {
    setError(null)
    try {
      onRestored(await restoreTrash(entry.id))
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== entry.id))
    } catch (err) {
      // The common failure is an entry that aged out while the list sat open.
      // Dropping the row alongside the message keeps the list honest rather
      // than leaving a button that will fail the same way again.
      setError(err instanceof Error ? err.message : 'Could not restore that item.')
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== entry.id))
    }
  }

  async function forget(entry: TrashEntry) {
    setError(null)
    try {
      await forgetTrash(entry.id)
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== entry.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that item.')
    }
  }

  // Loads on mount, and again whenever the tree changes underneath it. Being
  // mounted is being open now that this is a page rather than a fold, so the
  // "costs nothing unless expanded" property is carried by the route instead:
  // nothing here runs until you go to the trash.
  //
  // The tree dependency is what keeps the list honest. A permanent delete on
  // another device broadcasts the tree, so this refetches and the row it
  // removed goes — the stale-list case the buttons would otherwise fail on.
  useEffect(() => {
    void load()
  }, [tree, load])

  return (
    <section className="trash-page">
      <p className="trash-note">
        Deleted tasks and projects stay here for 30 days, then go on their own.
      </p>

      {error && <p className="trash-error">{error}</p>}

      {entries === null ? (
        <p className="trash-status">{busy ? 'Loading…' : ''}</p>
      ) : entries.length === 0 ? (
        <p className="trash-status">Nothing deleted.</p>
      ) : (
        <ol className="rail trash-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="trash-what">
                <span className="trash-text">{entry.text || 'Untitled'}</span>
                <span className="trash-meta">
                  {/* count includes the deleted node itself, so a subtree of one
                      is a plain task and says nothing extra. */}
                  {entry.count > 1 && `${entry.count - 1} subtask${entry.count === 2 ? '' : 's'} · `}
                  {ago(entry.deletedAt)} · {left(entry.deletedAt)}
                </span>
              </div>
              <div className="trash-actions">
                <button onClick={() => void restore(entry)} title="Put this back">
                  Restore
                </button>
                <button
                  className="danger"
                  onClick={() => void forget(entry)}
                  title="Delete for good, now"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
          {cursor !== undefined && (
            <li className="trash-more">
              <button disabled={busy} onClick={() => void load(cursor)}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}
        </ol>
      )}
    </section>
  )
}
