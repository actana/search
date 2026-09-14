# Runbook: Database Maintenance

Routine maintenance for the primary Postgres cluster. Everything here is
scheduled work; anything unplanned is an incident and follows the incident
runbook instead.

## Cluster layout

The cluster is one primary and two streaming replicas in separate availability
zones. The first replica is synchronous and is the failover target. The second
is asynchronous and serves read-only analytical traffic. Connection pooling
sits in front of both through a transaction-mode pooler.

Failover is automatic when the primary fails a health check three times in
thirty seconds. The pooler is reconfigured by the failover hook, so
application connections reconnect without a deploy. Expect fifteen to forty
seconds of write unavailability during a failover.

## Vacuum and bloat

Autovacuum is enabled and tuned per table. The high-churn tables — the job
queue, the execution log, the session table — use a scale factor of one
percent so they are vacuumed frequently rather than in huge batches.

Check bloat monthly with the standard bloat query. A table above forty percent
bloat that autovacuum is not recovering gets a repack during the maintenance
window. Never run a full vacuum on a live table: it takes an exclusive lock for
the duration and will take the service down with it.

Watch the transaction id age on every database weekly. If the oldest frozen
transaction id passes two hundred million, escalate: an aggressive freeze is
about to start on its own schedule and will compete with production traffic.

## Indexes

Build every index concurrently. A concurrent build takes longer and can fail,
leaving an invalid index behind; drop the invalid index and retry rather than
reindexing the table. Review unused indexes quarterly — an index that has never
been scanned costs write throughput for nothing.

Reindex concurrently during the maintenance window when an index is more than
thirty percent bloated. The vector indexes are the exception: rebuilding one is
expensive, so it is done only after a large bulk load.

## Backups

A base backup runs nightly at zero two hundred hours and is retained for
thirty-five days. Write-ahead log segments ship continuously to object storage,
giving point-in-time recovery to any second within the retention window.

A restore rehearsal runs on the first working day of every month: restore the
most recent base backup into a scratch cluster, replay to a chosen timestamp,
and run the consistency checks. The rehearsal is not optional and its result is
recorded in the operations log. A backup that has never been restored is a
hope, not a backup.

## The maintenance window

The window is zero one hundred to zero three hundred hours on Sunday. Schema
changes, repacks, reindexes, and version upgrades happen there. Announce the
window in the operations channel on the preceding Friday with the planned
changes and the expected impact.

Minor version upgrades are applied within one month of release. Major version
upgrades are planned separately with a logical replication cutover and a
rehearsed rollback.
