---
title: MySQL Third-Party Replication POC
---

<div class="dashboard narrative introduction" id="introduction">

# MySQL Third-Party Replication POC

Evaluate whether Maxwell, Pub/Sub and a custom Swift consumer can replicate supported schema and data changes from **MySQL 8.4 to MySQL 5.7**, detect failures, and recover without silently skipping changes.

## Architecture under test

<div id="architecture-diagram" aria-label="POC architecture including the dead-letter queue" role="img"></div>

The databases, Maxwell daemon, Pub/Sub emulator and Swift consumer run in Docker containers. Maxwell reads the source database's binlog and publishes change events. The Swift consumer reads those events and applies supported changes to the target database.

The consumer keeps applied-event records, checkpoints and recovery information in the target's `cdc_meta` schema. Replicated application tables are separate from those records.

**Dead-letter queue (DLQ):** when an event cannot be applied, the consumer keeps the blocked event and publishes a diagnostic to a separate Pub/Sub topic. Later changes must not pass the blocked event. Each test page shows its recorded DLQ delivery count, including **0** when no deliveries were observed. Missing evidence is shown as **Not recorded**, not zero.

## How the POC is tested

The test scripts start isolated Docker Compose stacks. The Swift harness creates schemas and writes data on the source, observes the change stream and DLQ, and checks the target against the expected events, schemas and rows. Recovery tests also stop services and introduce errors.

The harness saves results, database comparisons and logs under `artifacts/`. This dashboard reads those files; it does not need the original test containers to remain running. Container information is a recorded snapshot, not live monitoring.

## Read the results in this order

<div class="test-chapters">
<a href="/basics"><span>1 · Phase 3</span><strong>Basic replication</strong><p>Do supported schema and data changes arrive correctly? Does the verifier detect missing or incorrect data?</p></a>
<a href="/recovery"><span>2 · Phase 4</span><strong>Recovery</strong><p>What happens when services stop, events are replayed, or target errors need repair?</p></a>
<a href="/failures"><span>3 · Phase 5</span><strong>Failure handling and load</strong><p>Does invalid input block safely? Do committed changes arrive while a backlog drains?</p></a>
</div>

Each page explains the procedure, shows one selected run, and links each result to its evidence. A passed negative test means the intended failure was detected; it does not mean the rejected event was applied or repaired. Memory is measured only for Maxwell and the Swift consumer.

## What this POC can establish

The tests provide evidence for the supported schema and event-handling contract in a local environment. They do not establish production readiness, support for every MySQL operation, initial copying of an existing database, or atomic visibility of a whole source transaction on the target. The emulator is not a durable production broker.

<h2 id="next-step">Decision supported by the evidence</h2>

Use the individual test results to decide whether to approve a bounded, non-production trial against real Pub/Sub and the intended database versions. Before a production decision, validate secure connectivity, ordering and redelivery, required schema coverage, recovery procedures, and representative load. Local memory and timing measurements are not production capacity guarantees.

[Open detailed evidence, supporting Phase 1–2 runs and suite reports](/evidence)

</div>

```js
import {introduction} from "./components/introduction.js";
await introduction(document.querySelector("#introduction"));
```
