/**
 * Audit gate, engagement filter, buyer-title check, per-contact decision,
 * HubSpot update plan, circuit breaker and savings estimate.
 */

const DAY = 24 * 3600 * 1000;

/** Rolling gate: the audit is due when `intervalDays` have passed since the last completed run. */
export function isAuditDue({ lastCompletedAt, nowMs, intervalDays, force = false }) {
  if (force) return { due: true, reason: 'forced' };
  const last = Date.parse(lastCompletedAt || '');
  if (!Number.isFinite(last)) return { due: true, reason: 'first_run' };
  const daysSince = (nowMs - last) / DAY;
  return daysSince >= intervalDays
    ? { due: true, reason: 'interval_elapsed', daysSince: Math.floor(daysSince) }
    : { due: false, reason: 'not_due', daysSince: Math.floor(daysSince), nextDueAt: new Date(last + intervalDays * DAY).toISOString() };
}

function parseHubSpotTime(value) {
  if (value === undefined || value === null || value === '') return NaN;
  if (/^\d{10,13}$/.test(String(value))) return Number(String(value).length === 13 ? value : Number(value) * 1000);
  return Date.parse(String(value));
}

/** A contact counts as engaged if any engagement timestamp is newer than the cutoff. */
export function recentEngagement(properties, cutoffMs, engagementProps) {
  for (const prop of engagementProps) {
    const t = parseHubSpotTime(properties[prop]);
    if (Number.isFinite(t) && t >= cutoffMs) return prop;
  }
  return null;
}

export function recentlyChecked(properties, nowMs, recheckAfterDays) {
  const t = parseHubSpotTime(properties.list_hygiene_checked_at);
  return Number.isFinite(t) && nowMs - t < recheckAfterDays * DAY;
}

export function matchBuyerTitle(jobTitle, titles) {
  const title = String(jobTitle || '').trim().toLowerCase();
  if (!title) return { match: 'missing', keyword: null };
  const hasWord = (kw) => new RegExp(`(?:^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z]|$)`).test(title);
  const excluded = titles.excludedKeywords.find(hasWord);
  if (excluded) return { match: 'non_target', keyword: excluded, excluded: true };
  const target = titles.targetKeywords.find(hasWord);
  return target ? { match: 'target', keyword: target } : { match: 'non_target', keyword: null };
}

const EMAIL_STATUS_TO_HYGIENE = {
  hard_bounce: 'quarantine_bounced',
  invalid: 'quarantine_invalid',
  disposable: 'quarantine_disposable',
  spamtrap: 'quarantine_risky',
  do_not_mail: 'quarantine_risky',
};

/** Returns { status, reason, changes, nonMarketing } for one contact, or { status: null } to leave it untouched. */
export function decideContact({ contact, emailCheck, titles, policy }) {
  const props = contact.properties;
  const title = matchBuyerTitle(props.jobtitle, titles);
  const exempt = policy.exemptLifecycleStages.includes(String(props.lifecyclestage || '').toLowerCase());
  let status = null;
  let reason = '';
  if (!emailCheck || emailCheck.status === 'error') {
    return { status: null, reason: `verification unavailable (${emailCheck ? emailCheck.detail : 'no result'}): left unchanged`, title, emailStatus: 'error' };
  }
  if (EMAIL_STATUS_TO_HYGIENE[emailCheck.status]) {
    status = EMAIL_STATUS_TO_HYGIENE[emailCheck.status];
    reason = `email ${emailCheck.status} (${emailCheck.source}${emailCheck.detail ? `: ${emailCheck.detail}` : ''})`;
  } else if (emailCheck.status === 'catch_all' || emailCheck.status === 'unknown') {
    status = policy.unverifiedAction === 'quarantine' ? 'quarantine_unverified' : 'flagged_unverified';
    reason = `email ${emailCheck.status}: deliverability could not be confirmed`;
  } else if (emailCheck.status === 'role') {
    status = policy.roleAddressAction === 'quarantine' ? 'quarantine_risky' : 'flagged_role_address';
    reason = `role address (${emailCheck.detail})`;
  } else if (title.match === 'missing') {
    status = titles.missingAction === 'flag' ? 'flagged_missing_title' : 'verified';
    reason = 'email valid, no job title';
  } else if (title.match === 'non_target') {
    status = titles.mismatchAction === 'quarantine' ? 'quarantine_title_mismatch' : 'flagged_title_mismatch';
    reason = `email valid, title outside buyer criteria${title.keyword ? ` (excluded: ${title.keyword})` : ''}`;
  } else {
    status = 'verified';
    reason = `email valid, buyer title (${title.keyword})`;
  }
  if (exempt && status.startsWith('quarantine_')) {
    reason = `${reason}; exempt lifecycle stage "${props.lifecyclestage}"`;
    status = 'exempt';
  }
  return {
    status,
    reason,
    title,
    emailStatus: emailCheck.status,
    nonMarketing: policy.nonMarketingStatuses.includes(status),
  };
}

export function buildContactUpdate({ contactId, decision, nowIso, policy }) {
  const properties = {
    list_hygiene_status: decision.status,
    list_hygiene_reason: decision.reason.slice(0, 500),
    list_hygiene_email_status: decision.emailStatus,
    list_hygiene_title_match: decision.title.match,
    list_hygiene_checked_at: nowIso,
  };
  if (decision.nonMarketing && policy.marketingStatusWriteMode === 'property') properties.hs_marketable_status = 'false';
  return { id: String(contactId), properties };
}

/** Stops all writes when an implausibly large share of contacts would be quarantined. */
export function evaluateCircuitBreaker({ processed, quarantined, policy }) {
  if (processed < policy.circuitBreakerMinSample) return { open: false, ratio: processed ? quarantined / processed : 0 };
  const ratio = quarantined / processed;
  return ratio > policy.maxQuarantineRatio
    ? { open: true, ratio, detail: `${Math.round(ratio * 100)}% of checked contacts would be quarantined (limit ${Math.round(policy.maxQuarantineRatio * 100)}%)` }
    : { open: false, ratio };
}

export function estimateSavings({ nonMarketingCount, savings }) {
  const monthly = (nonMarketingCount / 1000) * savings.monthlyCostPer1000;
  return {
    contactsRemovedFromMarketing: nonMarketingCount,
    monthly: Math.round(monthly * 100) / 100,
    annual: Math.round(monthly * 12 * 100) / 100,
    currency: savings.currency,
    ratePer1000Monthly: savings.monthlyCostPer1000,
    note: 'Estimate only: HubSpot applies marketing-contact changes at the next tier update, and tiers are sold in blocks.',
  };
}
