# Maxwell MySQL consumer

A Swift consumer that applies Maxwell change events to MySQL. This proof of concept replicates schema and row changes from MySQL 8.4 to MySQL 5.7 through a local Google Pub/Sub emulator.

[View the results dashboard](https://kantselovich.github.io/maxwell-mysql-consumer/)

## How it works

```text
MySQL 8.4 source
    |
    | binary log: schema and row changes
    v
Maxwell daemon
    |
    | JSON change events
    v
Pub/Sub emulator
    |
    v
Swift MySQL consumer ---------> Pub/Sub dead-letter queue (DLQ)
    |                          Diagnostics for events it cannot apply
    | SQL changes
    v
MySQL 5.7 target
    +-- Application schemas and rows
    +-- cdc_meta: applied events, checkpoints, recovery records

Swift test harness (e2e container)
    +-- Writes schemas and data to MySQL 8.4
    +-- Checks schemas, rows and applied events on MySQL 5.7
    +-- Observes audit messages and DLQ diagnostics
    +-- Saves results for the dashboard
```

Maxwell reads the source database's binary log and publishes a JSON message for each captured change. Pub/Sub carries those messages to the Swift consumer.

The consumer processes events in order, applies supported SQL changes, and records progress on the target. It acknowledges a message after a successful apply. Recorded event identities prevent a repeated message from applying the same change twice. If an event fails, the consumer retains it, publishes a DLQ diagnostic, and holds later events while the problem is resolved.

Docker Compose runs both databases, Maxwell, the Pub/Sub emulator, the consumer, and the test harness. Test data is generated locally. The configuration uses local test credentials and binds exposed ports to localhost.

## Run the dashboard and tests

Start Docker Desktop or Docker with Compose v2, then run from the repository root:

```sh
make dashboard
```

Open [localhost:4173](http://localhost:4173), choose a test page, and enable **Follow latest**. Run one test command at a time:

| Page | What it checks | Command |
| --- | --- | --- |
| Basic replication | Inserts, updates, deletes, schema changes, and verification checks | `make test-basic-replication` |
| Recovery | Process crashes, outages, redelivery, target repair, and queue loss | `make test-recovery` |
| Failure handling and load | Invalid JSON | `make test-invalid-json` |
| Failure handling and load | Unsupported column changes | `make test-unsupported-schema` |
| Failure handling and load | Catching up while more rows are written | `make test-load` |

Each command starts its own containers and database storage. Results appear as they are saved. Basic replication produces three runs, including two checks that deliberately introduce errors to test the verifier. The load test defaults to 1,000 rows in a transaction followed by 1,000 more inserts; `make test-load ROWS=100` runs a smaller workload.

Results stay in `artifacts/`. Containers and database storage are cleaned up after each run. Add `KEEP_STACK=1` to retain them for inspection; the test prints the cleanup command. Stop the dashboard with `make dashboard-stop`.

Docker builds the Swift application and dashboard tools. The first build downloads dependencies. MySQL 5.7 and the emulator use amd64 images, which Docker Desktop emulates on Apple Silicon.

## Build the published dashboard

The repository includes a sanitized results snapshot in `dashboard/published/`, so a fresh clone can build the presentation using Node.js 24.13 or later:

```sh
cd dashboard
npm ci
npm run build
npm run preview
```

Preview at [localhost:4175/maxwell-mysql-consumer/](http://localhost:4175/maxwell-mysql-consumer/). Observable Framework packages the pages, selected results and charts into `dashboard/dist/`. When local artifacts exist, the build uses their latest runs; `SNAPSHOT_ROOT=published npm run build` reproduces the checked-in presentation.

GitHub Actions builds the checked-in snapshot and deploys **only `dashboard/dist/`** to Pages after a push to `main`. The repository contains the full project; the website contains the presentation and its exported checks and measurements.

After rerunning tests, use `npm run snapshot` from `dashboard/` to update the published results. Set `RUN_IDS` to select specific runs, including each failure/load scenario you want to present. Review and commit changes under `dashboard/published/`, then push. [Build and publishing details](dashboard/README.md#static-build-for-github-pages).

## Project layout

| Directory | Contents |
| --- | --- |
| `Sources/Consumer`, `Sources/ConsumerRuntime` | Consumer command and processing loop |
| `Sources/ReplicationCore` | Maxwell event decoding, identity, schema policy and recovery models |
| `Sources/MySQLTarget` | SQL application and durable target state |
| `Sources/PubSubTransport` | Pub/Sub emulator transport |
| `Sources/E2EHarness`, `scripts/` | Test workloads, verification and container lifecycle |
| `Tests/` | Swift unit tests |
| `docker/`, `compose*.yaml` | Local services and image customizations |
| `dashboard/` | Observable dashboard, reporting, browser tests and published results |
| `PLAN/` | Technical plan and recorded POC results |

The supported schema contract covers a defined set of MySQL operations. See the [test and implementation reference](docs/TESTING.md) for SQL coverage, recovery behavior, configuration and additional commands. See the [phased technical plan](PLAN/OPTION_1_TECHNICAL_PLAN.md) for the experiment's scope.

Run `make test` for the containerized Swift unit tests, `make dashboard-data-test` for reporting tests, and `make dashboard-test` for browser, data and visual checks.
