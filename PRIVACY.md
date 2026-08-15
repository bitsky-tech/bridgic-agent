# Privacy Notice

**Effective date:** August 11, 2026  
**Last updated:** August 11, 2026

This Privacy Notice explains how BitSky-Tech Inc. ("BitSky," "we," "us," or
"our") handles information in connection with the official `brdgic-agent` project
and distributions. The desktop product may also be displayed as **Bridgic
Agent**. In this Notice, "Bridgic Agent" refers to both names unless stated
otherwise.

## At a glance

- Bridgic Agent is designed to be local-first. Your conversations, instructions,
  workflows, scheduled-task definitions, files, and credentials are stored and
  processed locally except when a feature you choose requires communication
  with a model provider, website, update service, or other third party.
- Official builds may send limited, pseudonymous usage telemetry so we can
  measure matters such as daily active installations, active-use time, feature
  adoption, performance, and reliability.
- Usage telemetry does **not** include the content of your prompts,
  conversations, workflows, scheduled tasks, code, files, commands, tool
  inputs or outputs, browser activity, credentials, or raw logs.
- Where permitted by law, usage telemetry is enabled by default. You can turn
  it off at any time without losing core product functionality.
- We do not sell personal information, use telemetry for advertising, or use it
  to build profiles for decisions about individual users.

The sections below provide the complete details. If this summary conflicts
with another part of this Notice, the more specific provision controls.

## 1. Scope

This Notice applies to information processed by BitSky through:

- official Bridgic Agent applications, command-line tools, and update services;
- usage-telemetry endpoints operated for official Bridgic Agent distributions;
  and
- privacy, support, and security communications sent directly to BitSky.

This Notice does not apply to:

- independent forks, modified builds, plugins, skills, integrations, or
  distributions operated by third parties;
- third-party model providers, websites, APIs, repositories, or other services
  that you choose to access through Bridgic Agent; or
- a third party's collection of information on its own websites or services,
  even if Bridgic Agent links to or interoperates with them.

Maintainers and distributors of modified or downstream versions are
responsible for describing their own data practices. You can inspect the
source code of the version you use to understand its behavior.

## 2. Our privacy principles

We use the following principles when designing telemetry and other data
processing:

1. **Local-first processing.** User content should remain on the user's device
   unless the user invokes a feature that requires an external service.
2. **Content exclusion.** Product telemetry should measure that a feature was
   used, not what the user entered, created, viewed, or received.
3. **Data minimization.** We collect only fields reasonably needed for a stated
   purpose, use coarse categories where possible, and avoid persistent device
   identifiers supplied by the operating system or hardware.
4. **Transparency and control.** Collection should be understandable,
   inspectable, and easy to disable.
5. **Limited retention and access.** Event-level data is retained only as long
   as needed and is accessible only to authorized personnel and service
   providers with a need to use it for the purposes described here.

## 3. Information that stays local

Bridgic Agent stores information needed for its core operation on your device.
Depending on the features you use, this may include:

- prompts, conversation history, model responses, and agent execution state;
- workflow definitions, names, descriptions, and generated workflow files;
- scheduled-task definitions, timing information, and run history;
- files and folders that you attach or make available to a session;
- model-provider configuration, API keys, and authorization tokens;
- application settings, permissions, memories, local service tokens, and
  application logs; and
- locally generated identifiers and metadata needed to associate sessions,
  turns, workflows, and scheduled runs.

This locally stored information is not sent to BitSky merely because it exists
or because you use Bridgic Agent. It remains subject to risks on your own device,
including access by other software running under your user account. Current
releases may store provider credentials in the local application database
without application-level encryption at rest. Protect your operating-system
account and device accordingly. See [SECURITY.md](SECURITY.md) for current
security guidance and known limitations.

Uninstalling the application may not automatically remove every local data or
log file. You can delete local sessions and other records using available
product controls, or remove the application's data directory after stopping
the application. Back up anything you wish to keep first.

## 4. Usage telemetry

### 4.1 When telemetry operates

Only versions that implement and are configured to use the telemetry feature
send usage telemetry. The presence of this Notice alone does not cause a build
to transmit data.

In official releases that include usage telemetry:

- telemetry is enabled by default where applicable law permits this approach;
- an official build will not enable telemetry unless it also provides an
  accessible control to turn telemetry off; and
- declining or disabling telemetry does not restrict core product features.

Telemetry settings apply to BitSky's product analytics. They do not prevent
network communication that you request, such as calls to a model provider,
opening a website, downloading an update, or checking a remote repository.

### 4.2 What telemetry may include

Usage telemetry is designed to contain only the following categories:

| Category | Examples | Purpose |
| --- | --- | --- |
| Pseudonymous identifiers | A randomly generated installation identifier and a random event identifier | Estimate active installations, recognize repeat use, and deduplicate events |
| Event timing | Event timestamp, application start and stop, foreground/background state, active-time intervals, and coarse session duration | Calculate daily active use and active-use time and understand engagement trends |
| Feature usage | A fixed feature or action name, feature category, count, enabled/disabled state, and success, cancellation, or high-level failure category | Understand adoption and improve product design |
| Aggregate operation metrics | Counts and durations for agent turns, workflows, scheduled runs, tool categories, permission decisions, and similar product operations | Improve performance, reliability, and user experience |
| Technical environment | Bridgic Agent version, release channel, operating-system family and version, CPU architecture, application language, and time-zone offset | Diagnose version- or platform-specific problems and understand compatibility needs |
| Performance and reliability | Launch time, operation latency, resource-use buckets, sanitized error codes, and error categories | Detect regressions and prioritize fixes |

For example, telemetry may record that the `scheduled_run` feature completed in
a particular duration. It must not record the task's name, instructions, cron
expression, referenced workflow, result, or error text supplied by the user or
a provider.

The installation identifier is randomly generated by Bridgic Agent. It is not
derived from a hardware serial number, MAC address, advertising identifier,
hostname, account name, email address, or model-provider account. It identifies
an installation, not necessarily a person: multiple people may use one
installation, and one person may use multiple installations. We therefore use
"daily active installations" when that is the more accurate measurement.

Active-use time is an estimate based on application lifecycle, foreground
state, and limited activity signals. We do not record keystrokes, mouse
coordinates, clipboard contents, window contents, or the substance of an
interaction to calculate it. Idle time should be excluded or capped before an
active-duration event is sent.

The telemetry service necessarily receives a source IP address when a device
connects. We do not place the IP address in the analytics event payload or use
it as the installation identifier. BitSky or its hosting provider may process
it in short-lived network and security logs to deliver the request, prevent
abuse, and investigate incidents. We do not use telemetry to collect precise
location.

Random identifiers and IP addresses can still be personal information under
some laws. We therefore describe telemetry as **pseudonymous**, not anonymous,
until it has been aggregated or de-identified so that it can no longer
reasonably be linked to an individual or installation.

### 4.3 What telemetry does not collect

Usage telemetry does not collect:

- prompts, instructions, messages, conversation transcripts, model responses,
  reasoning, memories, or session titles;
- workflow or scheduled-task names, descriptions, definitions, timing rules,
  inputs, outputs, or generated content;
- source code, document contents, attachments, file or directory names, file
  paths, repository names or URLs, Git remotes, commit data, or diffs;
- shell commands, command-line arguments, environment-variable values, tool
  arguments, tool results, permission-request content, or browser history;
- URLs or page content viewed through the browser tool;
- API keys, access or refresh tokens, passwords, cookies, authorization
  headers, custom provider endpoints, or account identifiers;
- hostnames, operating-system usernames, hardware serial numbers, MAC
  addresses, advertising identifiers, contact lists, or precise location;
- raw application logs, raw exception messages, crash dumps, screenshots,
  screen recordings, memory dumps, or clipboard contents; or
- information used for targeted advertising or cross-context behavioral
  profiling.

Before an official build enables telemetry, its implementation must apply
field allowlists and filtering before transmission. Free-form strings and
arbitrary metadata must not be added to a telemetry event merely for
convenience. If a future feature would require collecting a category excluded
above, we will provide additional notice and obtain consent where required
before that collection begins.

### 4.4 Your telemetry choices

You can disable usage telemetry through the privacy or telemetry control made
available in the applicable official release. If an official build has no such
control, usage telemetry must remain disabled in that build.

Turning telemetry off:

- stops new product-analytics events from being sent after the setting takes
  effect;
- does not delete events already received by BitSky; and
- does not affect the application's core functionality.

Disabling telemetry deletes the local identifier used solely for telemetry. If
you later enable telemetry, Bridgic Agent creates a new identifier so later use is
not deliberately linked to telemetry sent before you opted out.

## 5. Communications you initiate with third parties

Bridgic Agent is an agent application. Some functionality necessarily sends data
outside your device at your direction. These communications are separate from
BitSky's usage telemetry.

### Model providers and custom endpoints

When you configure and use a model provider, Bridgic Agent sends the provider the
content and context needed to perform your request. Depending on the task, this
can include prompts, conversation context, selected file content, tool
descriptions, tool results, and other information the agent needs to operate.
The destination is the provider or custom endpoint you select. Its collection,
retention, training, and security practices are governed by its own terms and
privacy policy. Review them before sending confidential or regulated data.

BitSky does not receive this content merely because the official application
sends it directly to your selected provider. If you configure an endpoint
operated by BitSky, additional terms or notices for that service may apply.

### Websites, APIs, repositories, plugins, and skills

If you or the agent accesses a website, API, repository, plugin, skill, or
integration, the operator may receive ordinary network and request information
and any content submitted to that service. Bridgic Agent's permission controls can
help you review certain actions, but they do not replace the third party's
privacy practices or make the third-party service local.

### Software updates

Official packaged builds may contact an update service to check for and
download updates. The service may receive network information such as your IP
address and request metadata and may learn the application version or platform
needed to provide the correct update. Update traffic is operational traffic,
not product-usage telemetry, and may continue when product telemetry is off.

## 6. Information you provide directly to BitSky

If you email us, report a vulnerability, request support, participate in a
survey, or submit an issue or contribution, we receive the information you
choose to provide. This can include your name, email address, account handle,
message, and any logs or files you attach.

Please review and redact logs, screenshots, recordings, and diagnostic files
before sending them. They may contain prompts, file paths, usernames, tokens,
or other confidential information. We will use support and security
communications to respond, investigate, maintain project security, enforce our
rights, and improve Bridgic Agent. Public repository activity is also subject to
the repository host's privacy policy.

## 7. How we use information

We use information covered by this Notice to:

- operate, maintain, secure, and support official Bridgic Agent services;
- calculate aggregate measures such as daily active installations and
  active-use time;
- understand which features are used and how they perform;
- diagnose failures, regressions, abuse, and security incidents;
- plan compatibility work and product improvements;
- respond to communications and privacy requests;
- comply with law and protect users, BitSky, and others; and
- create aggregated or de-identified statistics that no longer reasonably
  identify an individual or installation.

We do not use usage telemetry to inspect user content, advertise to you,
determine eligibility for employment, credit, housing, insurance, or similar
services, or make decisions that produce legal or similarly significant
effects concerning an individual.

## 8. Legal bases

Where a law requires a legal basis for processing, we rely on one or more of
the following, as applicable:

- **Legitimate interests:** where permitted, to understand and improve product
  usage, maintain reliability, prevent abuse, secure our services, and respond
  to users. We balance those interests against the rights and expectations of
  users through content exclusions, pseudonymous identifiers, minimization,
  retention limits, and an unconditional telemetry off switch.
- **Performance of a contract or steps at your request:** when processing is
  needed to provide an official service or support you requested.
- **Legal obligations and protection of rights:** when processing is necessary
  to comply with law, respond to valid legal process, or establish, exercise,
  or defend legal claims.

## 9. Disclosure of information

We may disclose information covered by this Notice only as follows:

- **Service providers:** vendors that host or protect telemetry endpoints,
  store analytics data, monitor service reliability, or help us provide
  support. They may process information only for contracted purposes and under
  appropriate confidentiality, security, and data-protection obligations.
- **Legal and safety reasons:** when we reasonably believe disclosure is
  required by law or valid legal process, or is necessary to protect rights,
  safety, security, and integrity.
- **Corporate transactions:** in connection with a merger, financing,
  acquisition, reorganization, bankruptcy, or transfer of the project or
  relevant business assets, subject to applicable law and appropriate notice.
- **At your direction:** when you ask or consent to the disclosure.

Before an official release begins using a new analytics provider that will
receive personal information, we will identify the provider or otherwise give
the additional disclosure required by applicable law.

We do **not** sell personal information. We do **not** share personal
information for cross-context behavioral advertising, and we do not disclose
usage telemetry to data brokers.

## 10. Retention

Unless a longer period is required for security, legal compliance, or the
resolution of a specific dispute:

- event-level usage telemetry is retained for no more than **90 days**;
- network and security logs that may contain IP addresses are retained for no
  more than **30 days**;
- daily or monthly pseudonymous analytics derived from event data are retained
  for no more than **24 months**;
- backups containing telemetry age out within **90 days** after deletion from
  active systems; and
- aggregated or de-identified statistics that can no longer reasonably be
  linked to an individual or installation may be retained indefinitely.

Support, security, and privacy communications are retained only as long as
reasonably necessary to address the request, maintain an appropriate record,
and meet legal or security obligations.

Local data is retained on your device until you delete it, the application
removes it under its normal operation, or you remove the applicable local data
files. BitSky does not control retention by your model provider or another
third party.

## 11. Security

We use reasonable technical and organizational measures appropriate to the
nature of information we receive. Before an official build enables telemetry,
the telemetry system must include encryption in transit, access controls, data
minimization, field allowlists, separation from user content, and retention
enforcement.

No transmission or storage system is completely secure. Open-source
availability also does not by itself make a particular build trustworthy;
obtain official builds from a source you trust and verify release information
where possible. Please report suspected vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## 12. Your choices and rights

Depending on your location, you may have the right to:

- know whether we process personal information about you and obtain access to
  it;
- request correction, deletion, or a portable copy of eligible information;
- restrict or object to certain processing;
- withdraw consent at any time;
- receive equal service and not be discriminated against for exercising a
  privacy right; and
- complain to a data-protection or privacy regulator.

Because usage telemetry is pseudonymous and Bridgic Agent does not require a
BitSky account for ordinary local use, we may be unable to associate telemetry
with your name or email address. To request access to or deletion of
event-level telemetry, provide the installation identifier shown by the
privacy control in your version of Bridgic Agent, if available. We may need to
verify a request and may decline or limit it where permitted by law, including
when we cannot reasonably identify the relevant data. Aggregated or
de-identified information cannot be associated with an individual and may not
be included in a response.

To exercise a right, contact us using the details in Section 14. Authorized
agents may submit requests where applicable law permits. We will respond within
the period required by applicable law.

## 13. Changes to this Notice

We may update this Notice as Bridgic Agent, our telemetry implementation, service
providers, or applicable laws change. We will update the date at the top and
publish the revised Notice in the project repository. For a material change
that expands collection or use, an official release will provide additional
notice in the application or release notes and will obtain consent where
required before the new processing begins.

Older versions and independent forks may continue to operate under the notice
included with those versions. Review the Notice distributed with the build you
use.

## 14. Contact

The entity responsible for the processing described in this Notice is:

**BitSky-Tech Inc.**  
Email: <feedback@bitsky-tech.com>  
Project repository: <https://github.com/bitsky-tech/bridgic-agent>

Please include "Bridgic Agent privacy" in the subject line of privacy requests.
Do not include API keys, access tokens, private source code, prompts, or other
sensitive content in your message.
