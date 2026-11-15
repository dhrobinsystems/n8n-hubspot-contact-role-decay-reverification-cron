/**
 * HubSpot contacts client: paged search for aging contacts and guarded batch updates.
 *
 *   DRY_RUN=true      -> batch updates are recorded and returned, never sent
 *   SANDBOX_MODE=true -> writes require a SANDBOX / DEVELOPER_TEST account type,
 *                        or the portal ID in HUBSPOT_SANDBOX_PORTAL_ID
 *   placeholder token -> offline: search returns injected fixture contacts, writes are refused
 */
import { isUnsetValue } from './config.js';

export const CONTACT_READ_PROPERTIES = [
  'email', 'firstname', 'lastname', 'jobtitle', 'company', 'lifecyclestage', 'hs_marketable_status',
  'lastmodifieddate', 'hs_last_sales_activity_timestamp', 'notes_last_updated', 'hs_email_last_open_date',
  'hs_email_last_click_date', 'hs_sales_email_last_replied', 'recent_conversion_date',
  'hs_email_hard_bounce_reason_enum', 'hs_email_quarantined', 'hs_email_quarantined_reason', 'hs_email_bounce',
  'list_hygiene_status', 'list_hygiene_checked_at',
];

export const ENGAGEMENT_DATE_PROPERTIES = [
  'hs_last_sales_activity_timestamp', 'notes_last_updated', 'hs_email_last_open_date', 'hs_email_last_click_date',
  'hs_sales_email_last_replied', 'recent_conversion_date',
];

export class HubSpotGuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HubSpotGuardError';
    this.code = code;
  }
}

export class HubSpotHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubSpotHttpError';
    this.status = status;
    this.code = `http_${status}`;
  }
}

export function buildAgingSearchBody({ cutoffMs, onlyMarketingContacts, after }) {
  const base = [{ propertyName: 'lastmodifieddate', operator: 'LT', value: String(cutoffMs) }];
  if (onlyMarketingContacts) base.push({ propertyName: 'hs_marketable_status', operator: 'EQ', value: 'true' });
  const body = {
    filterGroups: [
      { filters: [...base, { propertyName: 'hs_last_sales_activity_timestamp', operator: 'LT', value: String(cutoffMs) }] },
      { filters: [...base, { propertyName: 'hs_last_sales_activity_timestamp', operator: 'NOT_HAS_PROPERTY' }] },
    ],
    properties: CONTACT_READ_PROPERTIES,
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
    limit: 100,
  };
  if (after) body.after = after;
  return body;
}

export function createContactsClient({
  token,
  dryRun = true,
  sandboxMode = true,
  sandboxPortalId = '',
  baseUrl = 'https://api.hubapi.com',
  searchDelayMs = 300,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  offlineContacts = [],
}) {
  const offline = isUnsetValue(token);
  const api = String(baseUrl).replace(/\/+$/, '');
  let sandboxVerdict = null;

  async function request(method, path, body) {
    if (offline) throw new HubSpotGuardError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, 15000));
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        const err = new HubSpotHttpError(`HubSpot ${method} ${path} failed with HTTP ${response.status}`, response.status);
        err.body = text.slice(0, 500);
        throw err;
      }
      return text ? JSON.parse(text) : {};
    }
  }

  async function verifySandbox() {
    if (!sandboxVerdict) {
      sandboxVerdict = (async () => {
        const details = await request('GET', '/account-info/v3/details');
        const portalId = String(details && details.portalId !== undefined ? details.portalId : '');
        const accountType = String((details && details.accountType) || '').toUpperCase();
        if (!isUnsetValue(sandboxPortalId)) {
          if (portalId !== String(sandboxPortalId)) throw new HubSpotGuardError('sandbox_portal_mismatch', 'SANDBOX_MODE=true but the token is not for HUBSPOT_SANDBOX_PORTAL_ID');
        } else if (!['SANDBOX', 'DEVELOPER_TEST'].includes(accountType)) {
          throw new HubSpotGuardError('sandbox_account_required', `SANDBOX_MODE=true but the account type is "${accountType || 'unknown'}"`);
        }
        return { portalId, accountType };
      })();
    }
    return sandboxVerdict;
  }

  async function searchAgingContacts({ cutoffMs, onlyMarketingContacts, maxContacts }) {
    if (offline) return { contacts: offlineContacts.slice(0, maxContacts), pages: 0, truncated: offlineContacts.length > maxContacts };
    const contacts = [];
    let after;
    let pages = 0;
    do {
      if (pages > 0 && searchDelayMs) await sleep(searchDelayMs);
      const page = await request('POST', '/crm/v3/objects/contacts/search', buildAgingSearchBody({ cutoffMs, onlyMarketingContacts, after }));
      pages += 1;
      for (const c of (page && page.results) || []) contacts.push({ id: String(c.id), properties: c.properties || {} });
      after = page && page.paging && page.paging.next ? page.paging.next.after : undefined;
    } while (after && contacts.length < maxContacts && pages < 100);
    return { contacts: contacts.slice(0, maxContacts), pages, truncated: Boolean(after) || contacts.length > maxContacts };
  }

  /** inputs: [{ id, properties }]; sent in chunks of 100. */
  async function batchUpdateContacts(inputs) {
    if (!inputs.length) return { mode: 'skipped', updated: 0, batches: 0 };
    if (dryRun) return { mode: 'intercepted_dry_run', updated: 0, planned: inputs.length, batches: Math.ceil(inputs.length / 100), sample: inputs.slice(0, 3) };
    if (sandboxMode) await verifySandbox();
    let updated = 0;
    let batches = 0;
    const warnings = [];
    for (let i = 0; i < inputs.length; i += 100) {
      const chunk = inputs.slice(i, i + 100);
      try {
        await request('POST', '/crm/v3/objects/contacts/batch/update', { inputs: chunk });
      } catch (err) {
        const touchesMarketable = chunk.some((c) => 'hs_marketable_status' in c.properties);
        if (!(err instanceof HubSpotHttpError) || err.status !== 400 || !touchesMarketable) throw err;
        warnings.push('HubSpot rejected hs_marketable_status; retried without it (use the HubSpot workflow in the README)');
        await request('POST', '/crm/v3/objects/contacts/batch/update', {
          inputs: chunk.map((c) => {
            const { hs_marketable_status: _drop, ...rest } = c.properties;
            return { id: c.id, properties: rest };
          }),
        });
      }
      updated += chunk.length;
      batches += 1;
    }
    return { mode: 'written', environment: sandboxMode ? 'sandbox' : 'production', updated, batches, warnings: [...new Set(warnings)] };
  }

  return { offline, searchAgingContacts, batchUpdateContacts, verifySandbox };
}
