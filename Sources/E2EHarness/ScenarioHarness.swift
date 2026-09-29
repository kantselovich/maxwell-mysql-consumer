import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

struct HarnessArtifacts {
    let directory: String
    func save<T: Encodable>(_ value: T, _ name: String) throws {
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: URL(fileURLWithPath: directory + "/" + name), options: .atomic)
    }
}
private struct CapturedDelivery: Codable {
    let messageID: String
    let orderingKey: String
    let payload: String
    init(_ delivery: Delivery) {
        messageID = delivery.messageID; orderingKey = delivery.orderingKey
        payload = String(decoding: delivery.data, as: UTF8.self)
    }
}
private struct Observations: Codable {
    var deliveries: [CapturedDelivery] = []
    var identities: [String] = []
    var payloads: [String] = []
    var dlq: [CapturedDelivery] = []
    var duplicateDeliveries = 0
}
private struct ObserverRetryRecord: Codable {
    let timestamp: Date
    let operation: String
    let subscription: String
    let retry: Int
    let error: String
}

/// Independently drains audit and DLQ while the workload is writing. No access
/// to the consumer subscription; observing must never steal replication events.
private actor AuditObserver {
    let pubsub: PubSub
    let sourceID: String
    let artifacts: HarnessArtifacts
    var state = Observations()
    var canonicalByID: [String: String] = [:]
    var failure: HarnessFailure?
    var retries: [ObserverRetryRecord] = []
    init(pubsub: PubSub, sourceID: String, artifacts: HarnessArtifacts) {
        self.pubsub = pubsub; self.sourceID = sourceID; self.artifacts = artifacts
    }
    func snapshot() throws -> Observations {
        if let failure { throw failure }
        return state
    }
    private func rpc<T>(_ operation: String, _ subscription: String, body: () async throws -> T) async throws -> T {
        do {
            return try await ObserverRetry.call(operation: body, onRetry: { retry, error in
                retries.append(ObserverRetryRecord(timestamp: Date(), operation: operation,
                    subscription: subscription, retry: retry, error: String(describing: error)))
                try artifacts.save(retries, "observer-retries.json")
                print("RETRY observer \(operation) \(subscription): attempt=\(retry) error=\(error)")
            })
        } catch is CancellationError { throw CancellationError() }
        catch { throw HarnessFailure("observer", "\(operation) \(subscription): \(error)") }
    }
    func run() async {
        do {
            try artifacts.save(state, "observations.json")
            while !Task.isCancelled {
                let audit = try await rpc("pull", "cdc-audit") { try await pubsub.pull("cdc-audit") }
                state.deliveries += audit.map(CapturedDelivery.init)
                // Keep raw evidence even if decoding or a contract check fails.
                if !audit.isEmpty { try artifacts.save(state, "observations.json") }
                for delivery in audit {
                    guard delivery.orderingKey == "mysql84" else { throw HarnessFailure("ordering-key", "Audit event has wrong ordering key") }
                    let id = try MaxwellEvent(data: delivery.data).identity(source: sourceID)
                    let canonical = try ExactJSON(data: delivery.data).json
                    if let previous = canonicalByID[id] {
                        guard previous == canonical else { throw HarnessFailure("identity-collision", "Payload changed for \(id)") }
                        state.duplicateDeliveries += 1
                    } else {
                        canonicalByID[id] = canonical
                        state.identities.append(id)
                        state.payloads.append(String(decoding: delivery.data, as: UTF8.self))
                    }
                }
                if !audit.isEmpty { try artifacts.save(state, "observations.json") }
                try await rpc("ack", "cdc-audit") { try await pubsub.ack("cdc-audit", ids: audit.map(\.ackID)) }
                let dlq = try await rpc("pull", "cdc-dlq-observer") { try await pubsub.pull("cdc-dlq-observer") }
                state.dlq += dlq.map(CapturedDelivery.init)
                if !dlq.isEmpty { try artifacts.save(state, "observations.json") }
                try await rpc("ack", "cdc-dlq-observer") { try await pubsub.ack("cdc-dlq-observer", ids: dlq.map(\.ackID)) }
                guard state.dlq.isEmpty else { throw HarnessFailure("dlq", "Unexpected DLQ delivery; see observations.json") }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        } catch is CancellationError {
        } catch {
            failure = error as? HarnessFailure ?? HarnessFailure("observer", String(describing: error))
            try? artifacts.save(failure, "observer-error.json")
        }
    }
}

private struct ScenarioResult: Codable {
    let name: String
    let passed: Bool
    let elapsedSeconds: Double
    let cumulativeEvents: Int
    let failures: [HarnessFailure]
}
private struct RunResult: Codable {
    let passed: Bool
    let sourceID: String
    let configuration: HarnessConfiguration?
    let scenarios: [ScenarioResult]
    let failure: HarnessFailure?
}

public enum ScenarioHarness {
    public static func checkNegativeResult(settings: Settings) throws {
        let bytes = try Data(contentsOf: URL(fileURLWithPath: settings.artifacts + "/run-result.json"))
        let result = try JSONDecoder().decode(RunResult.self, from: bytes)
        let fault = ProcessInfo.processInfo.environment["HARNESS_FAULT"] ?? "none"
        let expected = fault == "missing-event" ? "event-manifest" : "row-mismatch"
        guard ["missing-event", "wrong-value"].contains(fault), result.configuration?.fault == fault,
              !result.passed, result.failure?.code == expected, result.scenarios.count == 1,
              result.scenarios[0].name == "crud", !result.scenarios[0].passed,
              result.scenarios[0].failures.map(\.code) == [expected] else {
            throw HarnessFailure("negative-self-test", "Negative test failed for the wrong reason or unexpectedly passed")
        }
        print("PASS negative self-test: independently detected \(expected)")
    }

    public static func run(_ pubsub: PubSub, settings: Settings) async throws {
        let artifacts = HarnessArtifacts(directory: settings.artifacts)
        let source = Database(), target = Database()
        var config: HarnessConfiguration?
        var results: [ScenarioResult] = []
        var collector: Task<Void, Never>?
        do {
            let configuration = try HarnessConfiguration(); config = configuration
            try artifacts.save(configuration, "configuration.json")
            try await PhaseOne.connect(source, host: settings.sourceHost)
            try await PhaseOne.connect(target, host: settings.targetHost)
            let sourceVersion = try await source.query("SELECT VERSION() AS version")
            let targetVersion = try await target.query("SELECT VERSION() AS version")
            try artifacts.save(["source": sourceVersion, "target": targetVersion], "versions.json")
            guard sourceVersion.first?["version"]?.hasPrefix("8.4.") == true,
                  targetVersion.first?["version"]?.hasPrefix("5.7.") == true else { throw HarnessFailure("versions", "Unexpected database versions") }
            guard try await target.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='poc'").isEmpty,
                  try await source.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='poc'").isEmpty,
                  try await target.query("SELECT event_id FROM cdc_meta.applied_events").isEmpty else {
                throw HarnessFailure("isolation", "Harness requires fresh source, target and ledger")
            }
            let observer = AuditObserver(pubsub: pubsub, sourceID: settings.sourceID, artifacts: artifacts)
            collector = Task { await observer.run() }

            // Real readiness barrier: source-only DDL + marker must traverse
            // Maxwell, the emulator and the applier before workload writes start.
            let markerTable = "h_\(configuration.runID)_markers"
            let createDB = "CREATE DATABASE poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            let createMarker = "CREATE TABLE poc.`\(markerTable)` (id INT PRIMARY KEY) ENGINE=InnoDB"
            var manifest = [ExpectedEvent(type: "database-create", sql: createDB),
                            ExpectedEvent(type: "table-create", table: markerTable, sql: createMarker),
                            ExpectedEvent(type: "insert", table: markerTable, data: ["id": .number("0")])]
            let markerSchema = Schema(exists: true, collation: "utf8mb4_unicode_ci", engine: "InnoDB",
                                      columns: [Column(name: "id", type: "int", nullable: false)],
                                      indexes: [TableIndex(name: "PRIMARY", columns: ["id"], unique: true)])
            var tables = [ExpectedTable(name: markerTable, schema: markerSchema, rows: [["id": "0"]])]
            try artifacts.save(manifest, "manifest.json")
            try await source.query(createDB); try await source.query(createMarker)
            try await source.query("INSERT INTO poc.`\(markerTable)` VALUES (0)")
            try await waitForMarker(0, table: markerTable, observer: observer, target: target,
                                    settings: settings, configuration: configuration, artifacts: artifacts)
            let ready = try await verify("readiness", manifest: manifest, tables: tables, observer: observer,
                                         source: source, target: target, artifacts: artifacts)
            guard ready.isEmpty else { throw ready[0] }
            print("PASS end-to-end CDC readiness")

            for (index, name) in configuration.scenarios.enumerated() {
                let start = Date()
                let plan = Scenarios.build(name, configuration: configuration)
                let markerID = index + 1
                manifest += plan.steps.map(\.expected)
                manifest.append(ExpectedEvent(type: "insert", table: markerTable, data: ["id": .number(String(markerID))]))
                tables.append(plan.table)
                tables[0].rows.append(["id": String(markerID)])
                try artifacts.save(plan, "\(name)-plan.json")
                try artifacts.save(manifest, "manifest.json")
                try artifacts.save(tables, "expected-tables.json")
                print("RUN \(name): rows=\(configuration.rows), seed=\(configuration.seed)")
                // The observer runs concurrently throughout paced writes and DDL.
                // This one source writer establishes deterministic operation order.
                for step in plan.steps {
                    _ = try await observer.snapshot()
                    if configuration.fault == "missing-event" && step.ephemeral { continue }
                    try await source.execute(step.sql, step.bindings.map(SQLValue.text))
                    if configuration.writeIntervalMS > 0 {
                        try await Task.sleep(nanoseconds: UInt64(configuration.writeIntervalMS) * 1_000_000)
                    }
                }
                // Writer is now quiescent; final marker shares the same stream/key.
                try await source.execute("INSERT INTO poc.`\(markerTable)` VALUES (?)", [.text(String(markerID))])
                try await waitForMarker(markerID, table: markerTable, observer: observer, target: target,
                                        settings: settings, configuration: configuration, artifacts: artifacts)
                if configuration.fault == "wrong-value" {
                    try await target.execute("UPDATE poc.`\(plan.table.name)` SET value=? WHERE id=1", [.text("deliberately wrong")])
                }
                let until = Date().addingTimeInterval(TimeInterval(configuration.drainSeconds))
                while Date() < until {
                    _ = try await observer.snapshot()
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                let failures = try await verify(name, manifest: manifest, tables: tables, observer: observer,
                                                source: source, target: target, artifacts: artifacts)
                let result = ScenarioResult(name: name, passed: failures.isEmpty, elapsedSeconds: Date().timeIntervalSince(start),
                                            cumulativeEvents: manifest.count, failures: failures)
                results.append(result)
                try artifacts.save(result, "\(name)-result.json")
                if let failure = failures.first { throw failure }
                print("PASS \(name): \(manifest.count) cumulative events, matching schema/rows, final marker, zero DLQ")
            }
            collector?.cancel(); await collector?.value
            _ = try await observer.snapshot()
            try artifacts.save(RunResult(passed: true, sourceID: settings.sourceID, configuration: config, scenarios: results, failure: nil), "run-result.json")
            await source.close(); await target.close()
        } catch {
            collector?.cancel(); await collector?.value
            let failure = error as? HarnessFailure ?? HarnessFailure("runtime", String(describing: error))
            // Preserve useful target state even on timeout/SQL/transport errors.
            if let ledger = try? await target.query("SELECT event_id FROM cdc_meta.applied_events ORDER BY event_id") { try? artifacts.save(ledger, "ledger.json") }
            if let checkpoints = try? await target.query("SELECT * FROM cdc_meta.checkpoints") { try? artifacts.save(checkpoints, "checkpoints.json") }
            try? artifacts.save(RunResult(passed: false, sourceID: settings.sourceID, configuration: config, scenarios: results, failure: failure), "run-result.json")
            await source.close(); await target.close()
            throw failure
        }
    }

    private static func waitForMarker(_ id: Int, table: String, observer: AuditObserver, target: Database,
                                      settings: Settings, configuration: HarnessConfiguration, artifacts: HarnessArtifacts) async throws {
        let deadline = Date().addingTimeInterval(TimeInterval(configuration.timeoutSeconds))
        while Date() < deadline {
            let observed = try await observer.snapshot()
            if let index = try observed.payloads.firstIndex(where: {
                let event = try ExpectedEvent.observed($0)
                return event.type == "insert" && event.table == table && event.dataJSON == ExactJSON.object(["id": .number(String(id))]).json
            }) {
                let checkpoints = try await target.execute("SELECT event_id FROM cdc_meta.checkpoints WHERE source_id=?", [.text(settings.sourceID)])
                try artifacts.save(checkpoints, "checkpoints.json")
                if checkpoints.first?["event_id"] == observed.identities[index] { return }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HarnessFailure("convergence-timeout", "Marker \(table)/\(id) did not reach audit and applied checkpoint within \(configuration.timeoutSeconds)s")
    }

    private static func verify(_ stage: String, manifest: [ExpectedEvent], tables: [ExpectedTable], observer: AuditObserver,
                               source: Database, target: Database, artifacts: HarnessArtifacts) async throws -> [HarnessFailure] {
        let observed = try await observer.snapshot()
        let ledger = try await target.query("SELECT event_id, CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload FROM cdc_meta.applied_events ORDER BY event_id")
        let journals = try await target.query("SELECT event_id, completed, before_schema, after_schema FROM cdc_meta.ddl_journal ORDER BY event_id")
        try artifacts.save(ledger, "ledger.json"); try artifacts.save(journals, "ddl-journal.json")
        var failures: [HarnessFailure] = []
        do { try HarnessAssertions.events(expected: manifest, payloads: observed.payloads, identities: observed.identities, ledger: ledger.compactMap { $0["event_id"] }) }
        catch { failures.append(error as? HarnessFailure ?? HarnessFailure("event-manifest", String(describing: error))) }
        // Compare ledger contents too, not only membership.
        let auditByID = Dictionary(uniqueKeysWithValues: zip(observed.identities, observed.payloads))
        for entry in ledger {
            guard let id = entry["event_id"], let payload = entry["payload"], let raw = auditByID[id] else { continue }
            if try ExactJSON(data: Data(payload.utf8)) != ExactJSON(data: Data(raw.utf8)) {
                failures.append(HarnessFailure("ledger-payload", "Stored payload differs for \(id)"))
            }
        }
        if journals.contains(where: { $0["completed"] != "1" }) { failures.append(HarnessFailure("pending-ddl", "Unresolved DDL journal entries")) }
        let quarantine = try await target.query("SELECT failure_id FROM cdc_meta.quarantine WHERE resolved=FALSE")
        let head = try await target.query("SELECT singleton FROM cdc_meta.consumer_head")
        if !quarantine.isEmpty || !head.isEmpty { failures.append(HarnessFailure("unresolved-event", "Pending stream head or unresolved quarantine")) }
        for (name, db) in [("source", source), ("target", target)] {
            let inventory = try await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='poc' ORDER BY TABLE_NAME")
            try artifacts.save(inventory, "\(stage)-\(name)-inventory.json")
            if inventory.compactMap({ $0["TABLE_NAME"] }).sorted() != tables.map(\.name).sorted() {
                failures.append(HarnessFailure("schema-mismatch", "Unexpected \(name) table inventory"))
            }
            if try await db.schema(table: nil) != Schema(exists: true, collation: "utf8mb4_unicode_ci") {
                failures.append(HarnessFailure("schema-mismatch", "Unexpected \(name) database charset/collation"))
            }
        }
        for table in tables {
            let a = try await source.schema(table: table.name), b = try await target.schema(table: table.name)
            try artifacts.save(["expected": table.schema, "source": a, "target": b], "\(stage)-\(table.name)-schema.json")
            if a != table.schema || b != table.schema { failures.append(HarnessFailure("schema-mismatch", "Schema differs from workload model for \(table.name)")) }
            let columns = try table.schema.columns.map { try quoteIdentifier($0.name) }.joined(separator: ",")
            let sql = try "SELECT \(columns) FROM poc." + quoteIdentifier(table.name) + " ORDER BY id"
            // Missing tables/columns are recorded as schema failure above; retain
            // that useful diff instead of replacing it with a generic SQL error.
            if a == table.schema && b == table.schema {
                let sourceRows = try await source.query(sql), targetRows = try await target.query(sql)
                try artifacts.save(["expected": table.rows, "source": sourceRows, "target": targetRows], "\(stage)-\(table.name)-rows.json")
                do { try HarnessAssertions.rows(expected: table.rows, source: sourceRows, target: targetRows, table: table.name) }
                catch let failure as HarnessFailure { failures.append(failure) }
            }
        }
        try artifacts.save(failures, "\(stage)-diffs.json")
        return failures
    }
}
