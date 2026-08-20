# SpinFamily Security Policy

**Inherited baseline:** Rootlayer Security Baseline — Candidate, August 19, 2026  
**Product:** SpinFamily  
**Security owner:** Rootlayer Software  
**Current product state:** Public prototype / beta; formal MVP validation required

SpinFamily inherits the Rootlayer Security Baseline. This repository-facing policy intentionally avoids publishing internal architecture, trust boundaries, credential inventories, vendor topology, authentication internals, data-flow detail, defensive configuration, or remediation procedures. Those materials belong in controlled internal security documentation and governance evidence.

## Supported Versions / Builds

Security support applies to the maintained SpinFamily prototype/beta and active validation work.

| Build / State | Security support |
| --- | --- |
| Active public prototype / beta | Supported for validation |
| Maintained candidate build | Supported |
| Superseded snapshots | Historical evidence only unless explicitly reactivated |

## Reporting a Vulnerability

Do not report suspected SpinFamily vulnerabilities through public GitHub issues, public discussions, social media, or other public channels.

Use GitHub Private Vulnerability Reporting when enabled for this repository. Until that feature is enabled, report vulnerabilities privately to the repository owner through an approved Rootlayer private channel.

Include, when available, the affected build or commit, vulnerability type, reproducible steps, observed impact, and whether sensitive information, privileged behavior, or active exploitation may be involved. Do not include live credentials or sensitive user information unless a secure private exchange has been established.

## Product-Specific Controls and Exceptions

SpinFamily applies the Rootlayer Security Baseline with additional controls appropriate to a public-facing prototype.

At the repository-policy level, the following requirements apply:

- public-facing inputs and state changes are treated as untrusted until validated;
- sensitive information and credentials remain outside source control;
- privileged functionality, if introduced, requires authenticated and authorized access;
- access follows least privilege;
- public deployment does not establish security or MVP approval;
- security-relevant changes preserve appropriate evidence;
- third-party dependencies and integrations are reviewed before production reliance;
- material exceptions require explicit, traceable human approval.

Detailed architecture, hosting configuration, trust boundaries, data flows, dependency topology, credentials, defensive controls, and remediation procedures are maintained in controlled internal documentation rather than this repository-facing policy.

## Exceptions / Risk Acceptances

No permanent security exceptions are approved by this policy. Prototype limitations or deferred controls are not accepted production risks by default. Material deviations from the Rootlayer Security Baseline require explicit, traceable human approval or documented risk acceptance.

## Baseline Relationship

SpinFamily inherits the reusable Rootlayer Security Baseline and may adopt stricter controls as its architecture or risk profile changes. Material modifications or exceptions should preserve the applicable baseline version/date and rationale in controlled governance records.
