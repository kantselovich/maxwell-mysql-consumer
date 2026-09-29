export const stories = {
  3: {
    path: "/basics", title: "Basic replication", question: "Do schema and data changes arrive correctly in MySQL 5.7?",
    summary: "The harness creates a schema on the source, writes data, and checks that the target contains the expected schema and rows.",
    command: "make e2e-checks WRITE_INTERVAL_MS=250",
    commandDescription: "Run from the repository root. This runs append, update, delete and schema-change checks, then two verifier self-tests. Writes are paced at 250 ms so you can follow the results as they arrive. Each run saves its evidence under artifacts/.",
    steps: ["Start a fresh Docker Compose stack and confirm that a source-only table and marker reach the target.", "Run the selected workload: insert rows, update and delete rows, or add a column while writes continue.", "Wait for a final marker, then compare the planned events, captured events, target records, schemas and rows.", "In the verifier self-tests, deliberately omit changes or alter a target value. The harness must identify that exact error."],
    verification: ["Compare the event sequence and values with a plan generated before writing to the source.", "Compare expected schemas and rows with both databases, then check the target's applied-event records and checkpoint.", "For a normal replication run, require no pending schema changes and zero DLQ deliveries. For a self-test, require the specific expected failure."],
    sources: ["scripts/e2e.sh", "Sources/E2EHarness/ScenarioHarness.swift"]
  },
  4: {
    path: "/recovery", title: "Recovery", question: "Can replication recover from interruptions without losing or applying changes twice?",
    summary: "The test interrupts the consumer and other services, replays events, and repairs two deliberately introduced target errors.",
    command: "make phase4",
    commandDescription: "Run from the repository root. This starts a fresh stack and runs the recovery sequence, saving its results under artifacts/.",
    steps: ["Start with a working source and target, then stop the consumer at data-commit and schema-change boundaries.", "Interrupt target access and restart capture and source services. Check that changes arrive after service is restored.", "Introduce target errors, check that the consumer keeps the blocked event and publishes a DLQ diagnostic, then restart and retry.", "Repair the target and replay the original event. Verify that all intended changes apply and the two expected failures are resolved.", "Finally, restart the emulator and verify that lost broker resources cause a visible stop. Continuing after this check requires a fresh stack and workload."],
    verification: ["Reconcile expected and observed identities with the target's applied-event records after recovery.", "Check that retries do not apply an event twice and that an interrupted schema change completes safely.", "Verify two unique failures were recorded and resolved. Repeated DLQ deliveries must retain the same diagnostic.", "Check that emulator resource loss is detected rather than treated as a safe continuation."],
    sources: ["scripts/phase4.sh", "Sources/E2EHarness/PhaseFour.swift"]
  },
  5: {
    path: "/failures", title: "Failure handling and load", question: "Does invalid input stop safely, and can correct changes arrive while a backlog drains?",
    summary: "Separate runs test malformed input, unsupported schema changes, and a workload with transactions and a backlog. Select a run to see one experiment at a time.",
    command: "# Invalid-input tests\nbash scripts/phase5.sh malformed\nbash scripts/phase5.sh unsupported\n\n# Transaction and backlog workload\nmake e2e-load",
    commandDescription: "Run these commands from the repository root. Each starts a fresh stack and records a separate run. Use make phase5 to run the full regression suite, including the earlier replication and recovery tests.",
    steps: ["Create a fresh stack and verify a small valid baseline.", "For malformed input or unsupported schema changes, introduce one invalid event and then a later valid write.", "Check that the diagnostic retains the original input, later progress stays blocked, and restarting or retrying without a fix does not skip the problem.", "For a load run, commit multi-table writes, roll back other writes, rotate binlogs, and build a backlog while the consumer is stopped.", "Restart the consumer, keep writing, and verify the final data and event records. Record end-to-end timing and memory for Maxwell and the consumer."],
    verification: ["For invalid-input runs, verify the baseline applied, one unique failure was recorded, and the later write did not pass the blocked event.", "For load runs, reconcile all committed changes, verify schemas and rows, and require zero DLQ deliveries. Rolled-back writes must not appear.", "Measure latency from source submission to the observation of a target record. Backlog, start-up and polling time are included."],
    sources: ["scripts/phase5.sh", "scripts/phase5-suite.sh", "Sources/E2EHarness/PhaseFive.swift"]
  }
};

export const metricNames = {
  expectedEvents: "Expected events", measuredDMLEvents: "Timed row-change events", backlogEvents: "Initial backlog", backlogAtStreamStart: "Backlog when new writes began", backlogRecoverySeconds: "Backlog recovery time", backlogEventsPerSecond: "Backlog recovery rate", streamEventsPerSecond: "Continuing-write rate", latencyP50Seconds: "Median end-to-end latency", latencyP95Seconds: "95th percentile latency", latencyP99Seconds: "99th percentile latency"
};
