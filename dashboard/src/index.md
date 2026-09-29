---
title: MySQL Third-Party Replication POC
---

<div class="dashboard narrative introduction" id="introduction">

# MySQL Third-Party Replication POC

This POC tests replication from **MySQL 8.4 to MySQL 5.7** using Maxwell, Pub/Sub and a custom Swift consumer. It covers schema and data changes, recovery from service interruptions, and handling of invalid events.

## Architecture under test

<div id="architecture-diagram" aria-label="POC architecture including the test harness and dead-letter queue" role="img"></div>

**Maxwell's daemon** is a background process that reads MySQL's binary log, the database's record of changes. It converts those changes into JSON events and publishes them to Pub/Sub.

**Google Cloud Pub/Sub** is a messaging service. Publishers send messages to a topic, and subscribers receive them through subscriptions. This POC uses its local emulator to carry events from Maxwell to the Swift consumer. A separate audit subscription lets the harness check the same event stream.

**The Swift consumer** applies schema and data changes to the target database, one event at a time. It tracks applied events and recovery state in the target's `cdc_meta` schema.

**Dead-letter queue (DLQ):** when an event cannot be applied, the consumer holds it for repair, pauses later changes and publishes a diagnostic to a separate Pub/Sub topic. Each test page shows the observed DLQ delivery count, including **0**.

## How the POC is tested

The databases, Maxwell, Pub/Sub emulator, consumer and harness run in an isolated Docker Compose stack. The Swift harness runs in the `e2e` service. It creates schemas and writes data on the source, then compares both databases with the planned schemas, rows and events.

For recovery tests, the host scripts interrupt services between harness checks. Invalid-input tests check that the consumer retains the failed event and its diagnostic while later changes wait. Load tests also measure processing time and memory use for Maxwell and the consumer.

Results, database comparisons and logs are saved under `artifacts/`. This dashboard displays those records, with a run selector and rerun commands on each test page.

## Read the results in this order

<div class="test-chapters">
<a href="/basics"><span>1 · Phase 3</span><strong>Basic replication</strong><p>Do supported schema and data changes arrive correctly? Does the verifier detect missing or incorrect data?</p></a>
<a href="/recovery"><span>2 · Phase 4</span><strong>Recovery</strong><p>What happens when services stop, events are replayed, or target errors need repair?</p></a>
<a href="/failures"><span>3 · Phase 5</span><strong>Failure handling and load</strong><p>Does invalid input block safely? Do committed changes arrive while a backlog drains?</p></a>
</div>

</div>

```js
import {introduction} from "./components/introduction.js";
await introduction(document.querySelector("#introduction"));
```
