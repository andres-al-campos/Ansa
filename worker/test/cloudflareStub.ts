/**
 * A stand-in for `cloudflare:workers` under vitest.
 *
 * That module only exists inside workerd, so Vite fails to resolve it at import
 * analysis — before vi.mock can intercept anything. vite.config.ts aliases the
 * specifier here instead.
 *
 * The base class contributes nothing the tests exercise: it assigns ctx and env
 * and that is all AnsaTree uses it for. Everything with behaviour worth testing
 * — transactionSync, getWebSockets, acceptWebSocket — comes from the ctx the
 * test passes in, not from here.
 */

export class DurableObject<Env = unknown> {
  constructor(
    public ctx: DurableObjectState,
    public env: Env,
  ) {}
}
