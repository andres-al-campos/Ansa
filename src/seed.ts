import type { Tree } from './tree'

/**
 * Starter tree. Deliberately lopsided — one deep branch, one shallow, one
 * barely started — because a tidy uniform tree won't show whether zoom and the
 * leaf filter actually earn their place.
 */
const SPEC: Array<[string, string | null, string, boolean]> = [
  ['taxes', null, 'File the tax return', false],
  ['gather', 'taxes', 'Gather the documents', false],
  ['g1', 'gather', "Find last year's return PDF", true],
  ['g2', 'gather', 'Download bank statements as CSV', false],
  ['g3', 'gather', 'Dig out the P60', false],
  ['forms', 'taxes', 'Fill in the forms', false],
  ['p1', 'forms', 'Page 1 — personal details', false],
  ['p1a', 'p1', 'Type name and address', false],
  ['p1b', 'p1', 'Copy the NI number off the card', false],
  ['p2', 'forms', 'Page 2 — income', false],
  ['p2a', 'p2', 'Enter salary from the P60', false],
  ['p2b', 'p2', 'Add the freelance income', false],
  ['p2b1', 'p2b', 'Total up the invoices', false],
  ['p2b2', 'p2b', 'Convert the USD ones', false],
  ['p2b3', 'p2b', 'Check the exchange rate date', false],
  ['p3', 'forms', 'Page 3 — deductions', false],
  ['p3a', 'p3', 'List the work-from-home days', false],
  ['post', 'taxes', 'Send it off', false],
  ['po1', 'post', 'Print the summary page', false],
  ['po2', 'post', 'Walk it to the postbox', false],

  ['flat', null, 'Sort out the flat', false],
  ['fl1', 'flat', 'Email the landlord about the boiler', false],
  ['fl2', 'flat', 'Book a carpet clean', false],
  ['fl3', 'flat', 'Replace the hallway bulb', false],

  ['bike', null, 'Get the bike working again', false],
  ['bk1', 'bike', 'Work out what is actually wrong with it', false],
]

export function seedTree(): Tree {
  const now = Date.now()
  return SPEC.map(([id, parentId, text, done], i) => ({
    id,
    parentId,
    text,
    done,
    order: i,
    collapsed: false,
    createdAt: now + i,
  }))
}
