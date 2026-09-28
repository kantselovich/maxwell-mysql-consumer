import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

enum LoadStatistics {
    /// Nearest-rank percentiles; samples are observational upper bounds, not server commit latency.
    static func percentile(_ values: [Double], _ fraction: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        return values.sorted()[max(0, min(values.count - 1, Int(ceil(Double(values.count) * fraction)) - 1))]
    }
}

enum TransactionAssertions {
    static func ordered(_ payloads: [String]) throws {
        let events = try payloads.map { try MaxwellEvent(data: Data($0.utf8)) }
        try PhaseOne.require(events.count >= 2 && Set(events.compactMap(\.xid)).count == 1 && events.allSatisfy { $0.xid != nil }, "Transaction xid changed/missing")
        try PhaseOne.require(events.last?.commit == true && events.dropLast().allSatisfy { $0.commit != true }, "Wrong transaction boundary")
        try PhaseOne.require(events.dropLast().compactMap(\.xoffset) == (0..<(events.count - 1)).map(UInt64.init), "Transaction offsets are not contiguous")
    }
}

private struct LoadEvidence: Codable {
    var expected: [ExpectedEvent] = []
    var rows: [String: [String: [String: String]]] = ["load_a": [:], "load_b": [:]]
    var payloads: [String] = [], identities: [String] = []
    var submitted: [Int: Double] = [:], observed: [String: Double] = [:]
    var transactionRanges: [[Int]] = []
    var recoveryStarted: Double?, recoveryFinished: Double?
    var backlogEnd = 0
    var backlogAtStreamStart = 0
    var streamStarted: Double?, streamFinished: Double?
    var poisonKind: String?, poisonPayload: Data?, poisonMessageID: String?
    var baselineCheckpoint = ""
    var dlq: [QuarantineDiagnostic] = []
    var checks: [String] = []
}

/// Incremental, fresh-project gate. Only the host stops/starts containers.
/// Source intent and model are saved before writes; audit is independent of the apply ledger.
public final class PhaseFive {
    private let pubsub: PubSub, settings: Settings
    private let source = Database(), target = Database()
    private var state = LoadEvidence()
    private var config: HarnessConfiguration!
    private var artifacts: HarnessArtifacts { HarnessArtifacts(directory: settings.artifacts) }
    public init(pubsub: PubSub, settings: Settings) { self.pubsub = pubsub; self.settings = settings }

    public func run(_ action: String) async throws {
        do {
            config = try HarnessConfiguration()
            let url = URL(fileURLWithPath: settings.artifacts + "/load-state.json")
            if FileManager.default.fileExists(atPath: url.path) {
                state = try JSONDecoder().decode(LoadEvidence.self, from: Data(contentsOf: url))
            }
            try await PhaseOne.connect(source, host: settings.sourceHost)
            try await PhaseOne.connect(target, host: settings.targetHost)
            switch action {
            case "setup":
                try PhaseOne.require(state.expected.isEmpty, "Phase 5 requires fresh evidence")
                try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.applied_events").isEmpty, "Phase 5 requires a fresh ledger")
                try artifacts.save(config, "configuration.json")
                try artifacts.save(["source": try await source.query("SELECT VERSION() AS version"),
                                    "target": try await target.query("SELECT VERSION() AS version")], "versions.json")
                let create = "CREATE DATABASE poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                try await ddl(create, "database-create")
                for table in ["load_a", "load_b"] {
                    try await ddl("CREATE TABLE poc.\(table) (id INT PRIMARY KEY, value VARCHAR(80) NOT NULL) ENGINE=InnoDB", "table-create", table)
                }
                try await verify()
            case "backlog": try await backlog()
            case "mark-recovery":
                try await collect()
                try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.applied_events").count == 3, "Consumer must be stopped before backlog writes")
                try PhaseOne.require(state.expected.count > 3, "No backlog generated")
                state.recoveryStarted = Date().timeIntervalSince1970
            case "stream":
                let applied = try await target.query("SELECT event_id FROM cdc_meta.applied_events").count
                state.backlogAtStreamStart = state.backlogEnd - applied
                if config.rows >= 1000 { try PhaseOne.require(state.backlogAtStreamStart > 0, "Load probe started after backlog drained; no overlap exercised") }
                state.streamStarted = Date().timeIntervalSince1970; try save()
                for offset in 0..<config.rows {
                    let id = config.rows + 10 + offset
                    try await insert(offset % 2 == 0 ? "load_a" : "load_b", id, value(id))
                    if offset % 10 == 0 { try await collect() }
                    try await Task.sleep(nanoseconds: UInt64(config.writeIntervalMS) * 1_000_000)
                }
                try await verify()
                state.streamFinished = Date().timeIntervalSince1970
                try metrics()
            case "verify": try await verify()
            case "poison-malformed", "poison-unsupported":
                try await verify()
                state.baselineCheckpoint = try await checkpoint()
                state.poisonKind = String(action.dropFirst(7)); try save()
                if state.poisonKind == "malformed" {
                    state.poisonPayload = Data("{not-valid-json".utf8); try save()
                    state.poisonMessageID = try await pubsub.publish(topic: "cdc", data: state.poisonPayload!, key: "mysql84")
                } else {
                    // Real source DDL, understood by Maxwell but outside our explicit target policy.
                    try await source.query("ALTER TABLE poc.load_a MODIFY COLUMN value VARCHAR(120) NOT NULL")
                }
                // Wait for the poison itself before writing a dependent/following event.
                try await waitForPoison()
                try await source.query("INSERT INTO poc.load_b VALUES (900000,'behind-poison')")
                try await blocked()
            case "assert-blocked": try await blocked()
            default: throw POCError("Unknown Phase 5 action: \(action)")
            }
            state.checks.append(action); try save()
            print("PASS Phase 5 \(action): \(state.expected.count) expected positive events")
            await source.close(); await target.close()
        } catch {
            try? save()
            try? artifacts.save(["action": action, "error": String(describing: error)], "load-error.json")
            await source.close(); await target.close(); throw error
        }
    }
    private func save() throws { try artifacts.save(state, "load-state.json") }
    private func value(_ id: Int) -> String {
        "seed_\((config.seed &+ UInt64(id)) &* 6364136223846793005 &+ 1442695040888963407)"
    }
    private func data(_ id: Int, _ value: String) -> [String: ExactJSON] {
        ["id": .number(String(id)), "value": .string(value)]
    }
    private func intent(_ event: ExpectedEvent) throws { state.expected.append(event); try save() }
    private func ddl(_ sql: String, _ type: String, _ table: String? = nil) async throws {
        try intent(ExpectedEvent(type: type, table: table, sql: sql)); try await source.query(sql)
    }
    private func insert(_ table: String, _ id: Int, _ value: String, transaction: Bool = false) async throws {
        state.rows[table]![String(id)] = ["id": String(id), "value": value]
        if !transaction { state.submitted[state.expected.count] = Date().timeIntervalSince1970 }
        try intent(ExpectedEvent(type: "insert", table: table, data: data(id, value)))
        try await source.execute("INSERT INTO poc.\(table) VALUES (?,?)", [.text(String(id)), .text(value)])
    }
    private func commit(_ start: Int) async throws {
        let time = Date().timeIntervalSince1970
        for index in start..<state.expected.count { state.submitted[index] = time }
        state.transactionRanges.append(Array(start..<state.expected.count)); try save()
        try await source.query("COMMIT")
    }
    private func backlog() async throws {
        try PhaseOne.require(state.expected.count == 3, "Backlog must follow fresh setup")
        try await source.query("START TRANSACTION")
        let start = state.expected.count
        // One multi-row statement, followed by another table and repeated changes to the same key.
        for id in 1...2 {
            state.rows["load_a"]![String(id)] = ["id": String(id), "value": "initial"]
            try intent(ExpectedEvent(type: "insert", table: "load_a", data: data(id, "initial")))
        }
        try await source.query("INSERT INTO poc.load_a VALUES (1,'initial'),(2,'initial')")
        try await insert("load_b", 1, "other-table", transaction: true)
        for (old, new) in [("initial", "intermediate"), ("intermediate", "final")] {
            state.rows["load_a"]!["1"]!["value"] = new
            try intent(ExpectedEvent(type: "update", table: "load_a", data: data(1, new), old: ["value": .string(old)]))
            try await source.execute("UPDATE poc.load_a SET value=? WHERE id=1", [.text(new)])
        }
        state.rows["load_a"]!.removeValue(forKey: "2")
        try intent(ExpectedEvent(type: "delete", table: "load_a", data: data(2, "initial")))
        try await source.query("DELETE FROM poc.load_a WHERE id=2")
        try await commit(start)
        // None of these operations may appear in either audit or ledger, even if final state matches.
        try await source.query("START TRANSACTION")
        try await source.query("INSERT INTO poc.load_a VALUES (999999,'rolled-back')")
        try await source.query("UPDATE poc.load_a SET value='rolled-back' WHERE id=1")
        try await source.query("DELETE FROM poc.load_b WHERE id=1")
        try await source.query("ROLLBACK")
        try await source.query("START TRANSACTION")
        let largeStart = state.expected.count
        for offset in 0..<config.rows {
            let id = offset + 10
            try await insert(offset % 2 == 0 ? "load_a" : "load_b", id, value(id), transaction: true)
        }
        try await commit(largeStart)
        state.backlogEnd = state.expected.count; try save()
    }
    private func collect() async throws {
        let batch = try await pubsub.pull("cdc-audit")
        for message in batch {
            try PhaseOne.require(message.orderingKey == "mysql84", "Incorrect audit ordering key")
            if state.poisonKind == "malformed", message.data == state.poisonPayload { continue }
            let event = try MaxwellEvent(data: message.data)
            if state.poisonKind == "unsupported", event.type == "table-alter" {
                try PhaseOne.require(event.database == "poc" && event.table == "load_a" && (try ExactJSON(data: message.data).object?["sql"]?.string) == "ALTER TABLE poc.load_a MODIFY COLUMN value VARCHAR(120) NOT NULL", "Wrong poison DDL")
                state.poisonPayload = message.data; state.poisonMessageID = message.messageID
            }
            let id = try event.identity(source: settings.sourceID)
            if let index = state.identities.firstIndex(of: id) {
                try PhaseOne.require(try ExactJSON(data: message.data) == ExactJSON(data: Data(state.payloads[index].utf8)), "Audit identity collision")
            } else {
                state.identities.append(id); state.payloads.append(String(decoding: message.data, as: UTF8.self))
            }
        }
        let diagnostics = try await pubsub.pull("cdc-dlq-observer")
        for message in diagnostics { state.dlq.append(try JSONDecoder().decode(QuarantineDiagnostic.self, from: message.data)) }
        let ledger = try await target.query("SELECT event_id FROM cdc_meta.applied_events")
        let now = Date().timeIntervalSince1970
        for row in ledger where state.observed[row["event_id"]!] == nil { state.observed[row["event_id"]!] = now }
        if state.recoveryStarted != nil, state.recoveryFinished == nil, state.identities.count >= state.backlogEnd,
           state.identities.prefix(state.backlogEnd).allSatisfy({ state.observed[$0] != nil }) { state.recoveryFinished = now }
        try save()
        try await pubsub.ack("cdc-audit", ids: batch.map(\.ackID))
        try await pubsub.ack("cdc-dlq-observer", ids: diagnostics.map(\.ackID))
        if state.poisonKind == nil { try PhaseOne.require(state.dlq.isEmpty, "Unexpected DLQ in positive load run") }
    }
    private func checkpoint() async throws -> String {
        try await target.execute("SELECT event_id FROM cdc_meta.checkpoints WHERE source_id=?", [.text(settings.sourceID)]).first?["event_id"] ?? ""
    }
    private func verify() async throws {
        let deadline = Date().addingTimeInterval(Double(config.timeoutSeconds))
        while true {
            try await collect()
            if state.identities.count >= state.expected.count, state.observed.count >= state.expected.count,
               try await target.query("SELECT * FROM cdc_meta.consumer_head").isEmpty { break }
            try PhaseOne.require(Date() < deadline, "Load convergence timed out")
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let drain = Date().addingTimeInterval(Double(config.drainSeconds))
        while Date() < drain { try await collect(); try await Task.sleep(nanoseconds: 100_000_000) }
        let ledger = try await target.query("SELECT event_id,CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload,applied_at FROM cdc_meta.applied_events ORDER BY applied_at,event_id")
        try artifacts.save(ledger, "load-ledger.json")
        try HarnessAssertions.events(expected: state.expected, payloads: state.payloads, identities: state.identities, ledger: ledger.compactMap { $0["event_id"] })
        try PhaseOne.require(ledger.compactMap { $0["event_id"] } == state.identities, "Target commit order differs from source audit")
        let byID = Dictionary(uniqueKeysWithValues: zip(state.identities, state.payloads))
        for entry in ledger {
            try PhaseOne.require(try ExactJSON(data: Data(entry["payload"]!.utf8)) == ExactJSON(data: Data(byID[entry["event_id"]!]!.utf8)), "Ledger payload differs from audit")
        }
        for range in state.transactionRanges {
            try TransactionAssertions.ordered(range.map { state.payloads[$0] })
        }
        for table in ["load_a", "load_b"] {
            let expected = state.rows[table]!.values.sorted { Int($0["id"]!)! < Int($1["id"]!)! }
            let sourceRows = try await source.query("SELECT * FROM poc.\(table) ORDER BY id")
            let targetRows = try await target.query("SELECT * FROM poc.\(table) ORDER BY id")
            try artifacts.save(["expected": expected, "source": sourceRows, "target": targetRows], "\(table)-rows.json")
            try HarnessAssertions.rows(expected: expected, source: sourceRows, target: targetRows, table: table)
            let sourceSchema = try await source.schema(table: table), targetSchema = try await target.schema(table: table)
            try artifacts.save(["expected": Scenarios.baseSchema(), "source": sourceSchema, "target": targetSchema], "\(table)-schema.json")
            try PhaseOne.require(sourceSchema == Scenarios.baseSchema(), "Unexpected source schema")
            try PhaseOne.require(targetSchema == Scenarios.baseSchema(), "Unexpected target schema")
        }
        try PhaseOne.require(try await checkpoint() == state.identities.last, "Checkpoint is not the final event")
        try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.quarantine").isEmpty, "Unexpected quarantine")
        try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.ddl_journal WHERE completed=FALSE").isEmpty, "Incomplete DDL")
    }
    private func metrics() throws {
        guard let start = state.recoveryStarted, let end = state.recoveryFinished,
              let streamStart = state.streamStarted, let streamEnd = state.streamFinished else { throw POCError("Missing measurement boundaries") }
        let samples = state.submitted.keys.sorted().map { index in state.observed[state.identities[index]]! - state.submitted[index]! }
        try PhaseOne.require(samples.allSatisfy { $0 >= 0 }, "Measurement clock moved backwards")
        try artifacts.save(samples, "latency-samples-seconds.json")
        try artifacts.save([
            "expectedEvents": Double(state.expected.count), "measuredDMLEvents": Double(samples.count),
            "backlogEvents": Double(state.backlogEnd - 3), "backlogRecoverySeconds": end - start,
            "backlogAtStreamStart": Double(state.backlogAtStreamStart),
            "backlogEventsPerSecond": Double(state.backlogEnd - 3) / (end - start),
            "streamEventsPerSecond": Double(config.rows) / (streamEnd - streamStart),
            "latencyP50Seconds": LoadStatistics.percentile(samples, 0.5),
            "latencyP95Seconds": LoadStatistics.percentile(samples, 0.95),
            "latencyP99Seconds": LoadStatistics.percentile(samples, 0.99)
        ], "load-metrics.json")
    }
    private func waitForPoison() async throws {
        let deadline = Date().addingTimeInterval(Double(config.timeoutSeconds))
        while state.dlq.isEmpty || state.poisonPayload == nil {
            try await collect()
            try PhaseOne.require(Date() < deadline, "Poison did not reach DLQ")
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }
    private func blocked() async throws {
        try await waitForPoison()
        let until = Date().addingTimeInterval(Double(config.drainSeconds))
        let deadline = Date().addingTimeInterval(Double(config.timeoutSeconds))
        var followingCaptured = false
        repeat {
            try await collect()
            followingCaptured = state.payloads.contains { $0.contains("behind-poison") }
            try PhaseOne.require(try await checkpoint() == state.baselineCheckpoint, "Poison advanced checkpoint")
            try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.applied_events").count == state.expected.count, "Poison advanced ledger")
            try PhaseOne.require(try await target.query("SELECT * FROM poc.load_b WHERE id=900000").isEmpty, "Following event was applied")
            try PhaseOne.require(try await target.schema(table: "load_a") == Scenarios.baseSchema(), "Unsupported DDL changed target")
            let rows = try await target.query("SELECT * FROM cdc_meta.quarantine")
            try PhaseOne.require(rows.count == 1 && rows[0]["resolved"] == "0" && rows[0]["published"] == "1", "Wrong durable quarantine")
            let diagnostic = try JSONDecoder().decode(QuarantineDiagnostic.self, from: Data(rows[0]["diagnostic"]!.utf8))
            try PhaseOne.require(state.dlq.allSatisfy { $0 == diagnostic }, "Unexpected/changed DLQ diagnostic")
            try PhaseOne.require(diagnostic.delivery.payload == state.poisonPayload && diagnostic.sourceID == settings.sourceID && diagnostic.delivery.messageID == state.poisonMessageID, "Quarantine lost original envelope")
            let head = try await target.query("SELECT failure_id,envelope FROM cdc_meta.consumer_head")
            try PhaseOne.require(head.count == 1 && head[0]["failure_id"] == diagnostic.failureID, "Blocked head missing")
            let envelope = try JSONDecoder().decode(StoredDelivery.self, from: Data(head[0]["envelope"]!.utf8))
            try PhaseOne.require(envelope == diagnostic.delivery, "Head differs from DLQ")
            if state.poisonKind == "malformed" {
                try PhaseOne.require(diagnostic.eventID == nil && diagnostic.reason.contains("dataCorrupted"), "Wrong malformed failure")
            } else {
                try PhaseOne.require(diagnostic.eventID == (try MaxwellEvent(data: state.poisonPayload!).identity(source: settings.sourceID)) && diagnostic.reason.contains("Expected DROP in supported DDL subset"), "Wrong unsupported-DDL failure")
            }
            try await Task.sleep(nanoseconds: 100_000_000)
            try PhaseOne.require(Date() < deadline, "Following source write was not independently captured")
        } while Date() < until || !followingCaptured
        try PhaseOne.require(followingCaptured, "Following source write was not independently captured")
    }
}
