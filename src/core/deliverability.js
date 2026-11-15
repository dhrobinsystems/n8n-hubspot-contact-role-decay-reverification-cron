/**
 * Lightweight deliverability checks.
 *
 * I don't open SMTP connections from the automation host: port 25 is blocked on
 * most clouds, RCPT probing hurts the sending IP's reputation, and many corporate
 * mail servers answer "accept all". Instead the check combines:
 *   1. local signals: syntax, disposable domains, role addresses,
 *   2. HubSpot's own bounce signals (hard bounce reason, quarantined flag, bounce count),
 *   3. an optional verification API (ZeroBounce, NeverBounce, or a custom HTTPS endpoint).
 *
 * Normalized statuses: valid | invalid | hard_bounce | disposable | role | spamtrap |
 * do_not_mail | catch_all | unknown | error
 */
import { isUnsetValue } from './config.js';

export const DISPOSABLE_MAIL_DOMAINS = new Set([
  '10minutemail.com', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getnada.com', 'guerrillamail.com',
  'guerrillamail.net', 'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mailsac.com', 'mintemail.com', 'mohmal.com',
  'sharklasers.com', 'spam4.me', 'temp-mail.org', 'tempmail.net', 'tempr.email', 'throwawaymail.com', 'trashmail.com',
  'yopmail.com', 'yopmail.net',
]);

export const ROLE_LOCAL_PARTS = new Set([
  'admin', 'administrator', 'billing', 'contact', 'enquiries', 'hello', 'help', 'hr', 'info', 'inquiries', 'jobs',
  'marketing', 'no-reply', 'noreply', 'office', 'postmaster', 'press', 'sales', 'support', 'team', 'webmaster',
]);

const MAILBOX_SYNTAX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function mailboxParts(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at > 0 ? { email: e, local: e.slice(0, at), domain: e.slice(at + 1) } : { email: e, local: '', domain: '' };
}

/** Local + HubSpot signals. Returns a definitive status, or null when an API check is still useful. */
export function localDeliverabilitySignals(contactProps) {
  const { email, local, domain } = mailboxParts(contactProps.email);
  if (!email) return { status: 'invalid', source: 'local', detail: 'no email address' };
  if (!MAILBOX_SYNTAX_RE.test(email) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { status: 'invalid', source: 'local', detail: 'syntax' };
  }
  if (String(contactProps.hs_email_hard_bounce_reason_enum || '').trim()) {
    return { status: 'hard_bounce', source: 'hubspot', detail: `hard bounce: ${String(contactProps.hs_email_hard_bounce_reason_enum).slice(0, 60)}` };
  }
  if (String(contactProps.hs_email_quarantined).toLowerCase() === 'true') {
    return { status: 'hard_bounce', source: 'hubspot', detail: `HubSpot quarantined${contactProps.hs_email_quarantined_reason ? `: ${String(contactProps.hs_email_quarantined_reason).slice(0, 60)}` : ''}` };
  }
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (DISPOSABLE_MAIL_DOMAINS.has(parts.slice(i).join('.'))) return { status: 'disposable', source: 'local', detail: domain };
  }
  if (ROLE_LOCAL_PARTS.has(local.split('+')[0])) return { status: 'role', source: 'local', detail: local };
  return null;
}

/** Offline provider: deterministic rules on reserved test domains (RFC 2606). */
export function mockVerify(email) {
  const { domain } = mailboxParts(email);
  if (domain.endsWith('.invalid')) return { status: 'invalid', source: 'mock', detail: 'reserved .invalid domain' };
  if (domain === 'catch-all.example') return { status: 'catch_all', source: 'mock', detail: 'mock catch-all domain' };
  if (domain === 'unknown.example') return { status: 'unknown', source: 'mock', detail: 'mock unknown domain' };
  if (domain === 'spamtrap.example') return { status: 'spamtrap', source: 'mock', detail: 'mock spam trap' };
  return { status: 'valid', source: 'mock', detail: 'mock accept' };
}

const ZEROBOUNCE_MAP = {
  valid: 'valid', invalid: 'invalid', 'catch-all': 'catch_all', unknown: 'unknown', spamtrap: 'spamtrap', abuse: 'do_not_mail', do_not_mail: 'do_not_mail',
};
const NEVERBOUNCE_MAP = { valid: 'valid', invalid: 'invalid', disposable: 'disposable', catchall: 'catch_all', unknown: 'unknown' };

async function fetchJsonWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : {} };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One API verification. Provider errors become status "error" (never "invalid"). */
export async function apiVerify(email, { checker, fetchImpl }) {
  try {
    if (checker.provider === 'zerobounce') {
      const r = await fetchJsonWithTimeout(fetchImpl, `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(checker.apiKey)}&email=${encodeURIComponent(email)}&ip_address=`, { method: 'GET' }, checker.timeoutMs);
      if (!r.ok || r.body.error) return { status: 'error', source: 'zerobounce', detail: `HTTP ${r.status}` };
      const status = ZEROBOUNCE_MAP[String(r.body.status || '').toLowerCase()] || 'unknown';
      return { status: r.body.sub_status === 'role_based' && status === 'valid' ? 'role' : status, source: 'zerobounce', detail: String(r.body.sub_status || '').slice(0, 60) };
    }
    if (checker.provider === 'neverbounce') {
      const r = await fetchJsonWithTimeout(fetchImpl, `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(checker.apiKey)}&email=${encodeURIComponent(email)}`, { method: 'GET' }, checker.timeoutMs);
      if (!r.ok || r.body.status !== 'success') return { status: 'error', source: 'neverbounce', detail: `HTTP ${r.status}` };
      return { status: NEVERBOUNCE_MAP[String(r.body.result || '').toLowerCase()] || 'unknown', source: 'neverbounce', detail: String(r.body.result || '') };
    }
    if (checker.provider === 'custom') {
      const r = await fetchJsonWithTimeout(
        fetchImpl,
        checker.url,
        { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${checker.apiKey}` }, body: JSON.stringify({ email }) },
        checker.timeoutMs,
      );
      if (!r.ok) return { status: 'error', source: 'custom', detail: `HTTP ${r.status}` };
      const status = String(r.body.status || '').toLowerCase().replace('-', '_');
      const allowed = ['valid', 'invalid', 'hard_bounce', 'disposable', 'role', 'spamtrap', 'do_not_mail', 'catch_all', 'unknown'];
      return { status: allowed.includes(status) ? status : 'unknown', source: 'custom', detail: String(r.body.detail || '').slice(0, 60) };
    }
    return mockVerify(email);
  } catch (err) {
    return { status: 'error', source: checker.provider, detail: err && err.name === 'AbortError' ? 'timeout' : 'request failed' };
  }
}

/** Runs local signals first, then the API (rate-limited and capped by MAX_VERIFICATIONS_PER_RUN). */
export async function checkDeliverability(contacts, { checker, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const results = {};
  let apiCalls = 0;
  let skippedForCap = 0;
  for (const contact of contacts) {
    const local = localDeliverabilitySignals(contact.properties);
    if (local) {
      results[contact.id] = local;
      continue;
    }
    if (checker.provider === 'mock') {
      results[contact.id] = mockVerify(contact.properties.email);
      continue;
    }
    if (isUnsetValue(checker.apiKey) || apiCalls >= checker.maxVerifications) {
      results[contact.id] = { status: 'error', source: checker.provider, detail: 'verification cap reached' };
      skippedForCap += 1;
      continue;
    }
    if (apiCalls > 0 && checker.delayMs) await sleep(checker.delayMs);
    apiCalls += 1;
    results[contact.id] = await apiVerify(mailboxParts(contact.properties.email).email, { checker, fetchImpl });
  }
  return { results, apiCalls, skippedForCap };
}
