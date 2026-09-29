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

Docker Compose starts a group of containers from `compose.yaml`: MySQL 8.4 is the source, MySQL 5.7 is the target, and Maxwell, the Pub/Sub emulator and the Swift consumer carry changes between them. A short-lived `pubsub-init` container creates the topics and subscriptions before Maxwell starts.

Each test run gets its own containers, network and new database storage. The Swift test harness runs in the `e2e` container after the replication services are ready. It creates the test database and tables on MySQL 8.4, writes rows there, and compares MySQL 5.7 with the expected table definitions, data and events.

<div id="docker-configuration"></div>

For recovery tests, the host scripts interrupt services between harness checks. Invalid-input tests check that the consumer retains the failed event and its diagnostic while later changes wait. Load tests also measure processing time and memory use for Maxwell and the consumer.

Results, database comparisons and logs are saved under `artifacts/`. This dashboard displays those records, with a run selector and rerun commands on each test page.

After each run, the script removes that run's containers and database storage and keeps the saved results. Add `KEEP_STACK=1` to a test command to keep its containers and databases available for inspection.

</div>

```js
import {introduction} from "./components/introduction.js";
await introduction(document.querySelector("#introduction"));
```
