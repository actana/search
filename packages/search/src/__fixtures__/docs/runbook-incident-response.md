# Runbook: Incident Response

This runbook describes how an operational incident is detected, declared,
communicated, and closed. It applies to every production service.

## Severity levels

A severity one incident means the product is unavailable to most customers, or
customer data is at risk. It pages the on-call engineer immediately and the
incident commander within five minutes. Target time to mitigation is thirty
minutes.

A severity two incident means a major feature is broken or badly degraded for a
significant group of customers, with no data at risk. It pages the on-call
engineer during working hours and raises a high-priority alert outside them.
Target time to mitigation is four hours.

A severity three incident is a contained problem with a workaround: a single
customer affected, a slow query, a failing background job that will retry. It
opens a ticket and waits for the next working day.

Anyone may declare an incident and nobody is ever criticised for declaring one
that turns out to be minor. Downgrading is cheap; a late declaration is not.

## The on-call rotation

The rotation runs weekly, handing over at ten hundred hours on Wednesday. Each
rotation has a primary and a secondary. The primary acknowledges a page within
five minutes; an unacknowledged page escalates to the secondary after ten
minutes and to the engineering manager after twenty.

Handover is a written note in the on-call channel covering open incidents,
known flapping alerts, any freeze in effect, and anything deployed in the last
twenty-four hours that is worth watching.

## Running an incident

Declare the incident in the incident channel with the severity, a one-line
symptom, and the affected service. The tool opens a dedicated channel and a
timeline document automatically.

The incident commander coordinates and does not debug. A separate communications
lead writes customer-facing updates every thirty minutes for severity one and
every two hours for severity two, even when the update is "still
investigating". Everyone else works the problem.

Mitigate before you diagnose. A rollback to the last known good deployment is
almost always the fastest mitigation and is never the wrong first move. Feature
flags come next: disabling the newly enabled path restores service without a
deploy. Only after the bleeding stops does the team look for the cause.

## Rollback

Every service keeps the previous three deployments warm. Rolling back is a
single command against the deployment tool and takes under two minutes.
Database migrations are always written to be backward compatible for one
release, so a rollback of application code never requires a rollback of the
schema.

If a migration cannot be made backward compatible, it ships in two releases: the
first adds the new shape and dual-writes, the second removes the old shape.

## After the incident

Every severity one and severity two incident gets a written review within five
working days. The review states what happened, the customer impact in minutes
and accounts, the timeline, what went well, what was luck, and the follow-up
actions with owners and dates. Reviews are blameless: they describe systems and
decisions with the information available at the time, never individuals.

Follow-up actions are tracked like any other work and are reviewed monthly.
