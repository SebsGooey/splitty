// Local Stripe lifecycle fixture. Never use this as a deployed Worker entrypoint.
// Stripe test clocks advance Stripe's time, not the application's wall clock.
// Override only the account entitlement clock; authentication and webhook
// signature freshness still use real time. Everything else is the real Worker.
import worker, { Accounts as RealAccounts, BillRoom, Meter } from '../../src/worker.js';
export { BillRoom, Meter };
const hasSandboxKey = (env) => typeof env.STRIPE_SECRET_KEY === 'string' && /^(?:sk_test_|rk_test_|rkcs_test_).+/.test(env.STRIPE_SECRET_KEY);
export class Accounts extends RealAccounts {
  constructor(ctx, env) {
    if (!hasSandboxKey(env)) throw new Error('The Stripe clock fixture requires a sandbox key.');
    super(ctx, env);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/__test/account-time') {
      const { now } = await request.json();
      if (now !== null && (!Number.isSafeInteger(now) || now <= 0)) return new Response('Invalid time', {status:400});
      await this.ctx.storage.put('test-account-time', now);
      return Response.json({ now });
    }
    this.accountTime = await this.ctx.storage.get('test-account-time');
    return super.fetch(request);
  }
  entitlement(row, isAdmin, now) {
    return super.entitlement(row, isAdmin, this.accountTime ?? now);
  }
}
export default {
  async fetch(request, env, ctx) {
    if (!hasSandboxKey(env)) return new Response('Sandbox Stripe key required', {status:403});
    const url = new URL(request.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return new Response('Local fixture only', {status:403});
    if (url.pathname === '/__test/account-time') {
      if (request.method !== 'POST' || !env.TEST_CONTROL_TOKEN || request.headers.get('x-test-control') !== env.TEST_CONTROL_TOKEN) return new Response('Forbidden', {status:403});
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global')).fetch(new Request('https://do/__test/account-time', {method:'POST', body:await request.text()}));
    }
    return worker.fetch(request, env, ctx);
  },
};
