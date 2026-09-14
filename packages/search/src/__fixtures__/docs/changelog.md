# Changelog

All notable changes to the platform, newest first. Dates are release dates.

## 2026-09-02 — 4.7.0

Added the structured data chunker for spreadsheet and comma separated value
uploads, so a table is split along row boundaries with the header repeated on
every chunk instead of being cut mid-row.

Added per-agent branch previews: merging a branch now shows a field-by-field
diff of what will change before anything is written.

Changed the knowledge base retrieval blend to normalise the semantic and
keyword scores across the candidate set before mixing them. Previously the two
scores were mixed on their raw scales, which let a strong keyword match be
buried by a narrow spread of cosine distances.

Fixed a race where two documents uploaded into a brand new knowledge base at
the same moment could collide while creating the vector partition. Partition
creation now takes an advisory lock for the transaction.

## 2026-08-14 — 4.6.2

Fixed a regression where the workflow executor dropped the run path highlight
after a block retried, leaving the canvas showing a stale branch.

Fixed expense category totals rounding to the wrong currency unit in the
monthly export.

## 2026-08-01 — 4.6.0

Added hardware security key support for production access. Time based one time
codes remain acceptable for everything else and short message codes are no
longer accepted anywhere.

Added the incident timeline document: declaring an incident now opens a channel
and a timeline automatically, and every status change is appended to it.

Changed the default chunk overlap from two hundred tokens to one hundred and
twenty-eight. Existing knowledge bases keep their stored configuration and are
unaffected until they are re-ingested.

Removed the legacy per-document embedding loop. All ingestion now runs through
the resumable batch pipeline, which retries only the batches that failed.

## 2026-07-09 — 4.5.1

Fixed a crash when a knowledge base query was issued against a base whose
embedding endpoint had been deleted. The query now fails with a clear message
naming the endpoint.

Fixed the on-call escalation timer counting from the page's creation rather
than from its delivery, which made escalations fire early on delayed pages.

## 2026-06-20 — 4.5.0

Added cluster routing diagnostics to the query response, so a caller can see
which clusters a query landed in without rerunning the search.

Added the rollback command to the deployment tool, backed by three warm
previous deployments per service.

Changed the parental leave entitlement to twenty weeks for a birthing parent
and sixteen weeks for a non-birthing parent, applied to every leave starting
after this date.
