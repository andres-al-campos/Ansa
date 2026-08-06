/**
 * How this server parses a JSON request body.
 *
 * Its own module so a test can exercise the real thing. Fastify's default
 * parser rejects an *empty* body sent as `application/json` with
 * FST_ERR_CTP_EMPTY_JSON_BODY, before any route runs. That's how POST
 * /api/seed silently did nothing: the request carries no body but the client
 * sends its usual content-type header, so a fresh account got a 400 instead of
 * a tutorial — and the client ignored the status, so there was no error either.
 *
 * An empty body is `{}` here. A body that is present and malformed is still a
 * 400, tagged explicitly because a bare SyntaxError surfaces as a 500 and
 * blames the server for what the client sent.
 */

export type ParserDone = (err: Error | null, body?: unknown) => void

export function parseJsonBody(_req: unknown, body: string, done: ParserDone): void {
  if (body === '') return done(null, {})
  try {
    done(null, JSON.parse(body))
  } catch {
    const err = new Error('Body is not valid JSON.') as Error & { statusCode?: number }
    err.statusCode = 400
    done(err, undefined)
  }
}
