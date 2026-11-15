# ⚠️ Disclaimer & Liability Limitation

- Licensed under the MIT License.
- License: MIT © 2026 dhRobin Systems.
- Provided as-is, see the disclaimer.

---

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-contact-role-decay-reverification-cron`) are for educational and architectural demonstration purposes. I publish them as a reference implementation from dhRobin Systems, not as a managed product or service.

## No Liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, exemplary, or consequential damages resulting from the use, misuse, or deployment of these scripts. That includes, without limitation: valid contacts wrongly quarantined or set to non-marketing; invalid contacts left in place; lost campaign reach, pipeline, or revenue; HubSpot billing or tier outcomes that differ from the estimated savings; sender-reputation or deliverability problems; verification-provider charges; API rate-limit or quota overruns; data synchronization errors; CRM state discrepancies; and third-party service outages. This applies however the damage is caused and on any theory of liability, even if advised of the possibility of such damage.

## No Warranty

All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. I do not warrant compatibility with any specific version of n8n, Node.js, HubSpot, ZeroBounce, NeverBounce, Google Sheets, or any other service, or that their APIs, property names, statuses, and billing rules will keep the behaviour this project expects.

## Production Testing Required

Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Review the dry-run summary and a sample of the planned updates before every first live run and after every configuration change. Treat every change to Marketing Contact status as hard to reverse: HubSpot applies marketing-contact changes on its own billing schedule, and reverting them can affect your tier.

## Savings Are Estimates

Reported savings are an arithmetic estimate based on the rate you configure. Actual HubSpot invoices depend on your contract, tier blocks, update dates, and renewal terms. Validate any savings figure against your HubSpot billing before reporting it.

## Third-Party APIs & Compliance

Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR, UK GDPR, CCPA/CPRA, ePrivacy, CAN-SPAM, and any other applicable law), and security policies of HubSpot, email-verification providers, Google, and any other connected service. That includes:

- confirming a lawful basis for sending contact email addresses to a verification provider, and putting the required data processing agreement in place;
- honouring every contact's consent, subscription, and opt-out preferences, which this workflow does not change;
- making sure quarantine and non-marketing decisions don't discriminate against contacts on the basis of protected characteristics;
- reviewing every automated status change and keeping the audit log for your own records;
- honouring data subject requests and retention policies across HubSpot, verification providers, log destinations, and n8n execution data.

## Security

Placeholder detection, dry-run defaults, sandbox interlocks, and the circuit breaker reduce risk but do not eliminate it. You are responsible for protecting tokens and service-account keys, rotating credentials, restricting access to n8n and the log destination, and keeping all dependencies patched.

## Not Professional Advice

Nothing in this repository is legal, compliance, privacy, billing, or deliverability advice. Consult qualified professionals for your jurisdiction and use case.

---

Licensed under the MIT License. License: MIT © 2026 dhRobin Systems. Provided as-is, see the disclaimer.
