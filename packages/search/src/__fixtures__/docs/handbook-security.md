# Device and Account Security

Every Northwind Systems employee is responsible for the security of the
accounts and devices issued to them. This section describes the controls that
are mandatory, the ones that are recommended, and what to do when something
goes wrong.

## Laptops

Company laptops ship with full-disk encryption enabled and it must stay
enabled. The IT team verifies encryption status weekly through the device
management agent; a laptop that reports as unencrypted for more than
forty-eight hours loses access to the corporate network until it is
remediated.

Set your screen to lock after five minutes of inactivity. Lock the screen
manually whenever you step away from the machine, including at home. Do not
install an alternative operating system, disable the management agent, or
grant a third party remote control of the device.

Operating system updates are pushed automatically and must be installed within
seven days of release. Security patches marked critical must be installed
within forty-eight hours. The agent will force a restart after the deadline.

## Passwords and second factors

Use the company password manager for every work credential. Passwords must be
unique per service and at least sixteen characters; the password manager
generates these for you. Never reuse a work password on a personal service.

Multi-factor authentication is mandatory on every account that supports it.
Hardware security keys are issued on request and are required for anyone with
production access. Time-based one-time codes from an authenticator app are
acceptable elsewhere. SMS codes are not an acceptable second factor on any
company account.

Never approve a push notification you did not trigger. If you receive an
unexpected approval prompt, deny it and report it immediately — that prompt
means someone else already has your password.

## Phishing and suspicious mail

Report suspicious email with the Report Phishing button in the mail client.
Do not forward it, do not reply to it, and do not click a link to "check
whether it is real". The security team confirms every report within one
business hour and posts a notice to the company channel when a campaign is
targeting us.

Attackers most often impersonate the finance team requesting an urgent payment
change, or a senior leader requesting gift cards. No one at this company will
ever ask you to change bank details over email or chat. Verify any payment
change by voice with a number you already had.

## Production access

Production access is granted per role and reviewed every quarter. Access is
always through the bastion with a hardware key; there are no shared accounts
and no long-lived static credentials. Every production session is recorded.

Never copy production data to a laptop, a personal cloud drive, or a local
database. Use the masked staging dataset for debugging. Exports for a customer
request go through the data team, who log the export against the request.

## Reporting an incident

If you lose a device, suspect a compromised account, or notice unexpected
activity, contact the security team immediately on the incident channel or by
phone. There is no penalty for reporting a mistake quickly. The penalty is for
hiding one.
