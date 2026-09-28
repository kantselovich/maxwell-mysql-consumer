import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

private struct RecoveryEvidence: Codable {
    var expected: [ExpectedEvent] = []
    var payloads: [String] = []
    var identities: [String] = []
    var dlq: [QuarantineDiagnostic] = []
    var rows: [[String: String]] = []
    var hasNote = false
    var previousRow: [String: String] = [:]
    var repairRow: [String: String] = [:]
    var blockedCheckpoint = ""
    var blockedLedgerCount = 0
    var expectedFailures = 0
    var duplicateAuditDeliveries = 0
    var checks: [String] = []
}

/// The host controls actual process failures; each invocation resumes evidence
/// and the independent workload model from the test project's artifact volume.
public final class PhaseFour {
    private let pubsub: PubSub
    private let settings: Settings
    private let source = Database(), target = Database()
    private var state = RecoveryEvidence()
    private let table = "recovery_rows"
    private var artifacts: HarnessArtifacts { HarnessArtifacts(directory: settings.artifacts) }
    private var stateURL: URL { URL(fileURLWithPath: settings.artifacts + "/recovery-state.json") }
    public init(pubsub: PubSub, settings: Settings) { self.pubsub = pubsub; self.settings = settings }
    public func run(_ action: String) async throws {
        do {
            if FileManager.default.fileExists(atPath: stateURL.path) {
                state = try JSONDecoder().decode(RecoveryEvidence.self, from: Data(contentsOf: stateURL))
            }
            if action.hasPrefix("arm-") {
                let point = String(action.dropFirst(4))
                let directory = settings.artifacts + "/control"
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                let reached = URL(fileURLWithPath: directory + "/reached.json")
                if FileManager.default.fileExists(atPath: reached.path) { try FileManager.default.removeItem(at: reached) }
                let type = point == "ddl" ? "table-alter" : "update"
                try HarnessArtifacts(directory: directory).save(["point": point == "ddl" ? "before-commit" : point, "table": table, "type": type], "request.json")
                await source.close(); await target.close()
                return
            }
            if action == "setup" || action.hasPrefix("write-") || action == "replay" || action == "verify" {
                try await PhaseOne.connect(source, host: settings.sourceHost)
            }
            if !action.hasPrefix("write-") && action != "setup" && action != "replay" {
                try await PhaseOne.connect(target, host: settings.targetHost)
            }
            switch action {
            case "setup":
                try PhaseOne.require(state.expected.isEmpty, "Phase 4 requires a fresh project")
                let sql = "CREATE DATABASE poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                try await write(sql, expected: ExpectedEvent(type: "database-create", sql: sql))
                let create = "CREATE TABLE poc.\(table) (id INT PRIMARY KEY, value VARCHAR(100) NOT NULL) ENGINE=InnoDB"
                try await write(create, expected: ExpectedEvent(type: "table-create", table: table, sql: create))
                try await insert(1, "initial")
            case "write-ddl":
                let sql = "ALTER TABLE poc.\(table) ADD COLUMN note VARCHAR(40) NOT NULL DEFAULT 'new'"
                state.hasNote = true
                state.rows = state.rows.map { $0.merging(["note": "new"]) { _, new in new } }
                try await write(sql, expected: ExpectedEvent(type: "table-alter", table: table, sql: sql))
            case "write-outage":
                for id in 2...9 { try await insert(id, "backlog-\(id)") }
                try await update("after-outage")
            case "replay":
                guard let old = try state.payloads.first(where: { try MaxwellEvent(data: Data($0.utf8)).type == "update" }) else { throw POCError("Missing old update fixture") }
                _ = try await pubsub.publish(topic: "cdc", data: Data(old.utf8), key: "mysql84")
                try await update("after-old-replay")
            case "break-target":
                state.repairRow = state.rows.first { $0["id"] == "1" }!
                state.blockedCheckpoint = try await checkpoint()
                state.blockedLedgerCount = try await target.query("SELECT event_id FROM cdc_meta.applied_events").count
                state.expectedFailures += 1
                try save()
                try await target.query("DELETE FROM poc.\(table) WHERE id=1")
            case "fix-target":
                let names = state.hasNote ? ["id", "value", "note"] : ["id", "value"]
                try await target.execute("INSERT INTO poc.\(table) (\(names.joined(separator: ","))) VALUES (\(names.map { _ in "?" }.joined(separator: ",")))", names.map { .text(state.repairRow[$0]!) })
            case "verify": try await verify()
            case "assert-before-commit", "assert-after-commit", "assert-ddl":
                try await collect()
                let ledger = try await target.query("SELECT event_id FROM cdc_meta.applied_events")
                let committed = action == "assert-after-commit"
                try PhaseOne.require(ledger.count == state.expected.count - (committed ? 0 : 1), "Wrong ledger at crash boundary")
                if action == "assert-ddl" {
                    try PhaseOne.require(try await target.schema(table: table).columns.contains { $0.name == "note" }, "Implicit DDL commit did not survive kill")
                    try PhaseOne.require(try await target.query("SELECT event_id FROM cdc_meta.ddl_journal WHERE completed=FALSE").count == 1, "Expected incomplete DDL journal")
                } else {
                    let row = try await target.query("SELECT * FROM poc.\(table) WHERE id=1").first
                    try PhaseOne.require(row == (committed ? state.rows.first { $0["id"] == "1" } : state.previousRow), "Wrong row at crash boundary")
                }
                try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.consumer_head").count == 1, "Crash lost durable head")
            case "assert-quarantine-durable":
                let rows = try await target.query("SELECT * FROM cdc_meta.quarantine WHERE resolved=FALSE")
                try PhaseOne.require(rows.count == 1 && rows[0]["published"] == "0", "Quarantine must be durable before publication")
                try await blockedInvariant()
            case "assert-blocked": try await blocked()
            case "assert-duplicate-dlq":
                try await collect()
                let groups = Dictionary(grouping: state.dlq, by: \.failureID)
                try PhaseOne.require(groups.values.contains { $0.count >= 2 }, "Interrupted publish did not exercise duplicate diagnostics")
            case "assert-resources-lost":
                do { try await pubsub.checkSubscription("cdc-consumer"); throw POCError("Emulator unexpectedly retained resources") }
                catch { guard PubSub.isMissingResource(error) else { throw error } }
                try PhaseOne.require(try await target.query("SELECT event_id FROM cdc_meta.applied_events").count == state.expected.count, "Queue loss altered applied ledger")
            default:
                guard action.hasPrefix("write-") else { throw POCError("Unknown Phase 4 action: \(action)") }
                try await update(String(action.dropFirst(6)))
            }
            state.checks.append(action); try save()
            print("PASS Phase 4 \(action)")
            await source.close(); await target.close()
        } catch {
            try? artifacts.save(["action": action, "error": String(describing: error)], "recovery-error.json")
            await source.close(); await target.close(); throw error
        }
    }
    private func save() throws { try artifacts.save(state, "recovery-state.json") }
    private func rowJSON(_ row: [String: String]) -> [String: ExactJSON] {
        row.mapValues(ExactJSON.string).merging(["id": .number(row["id"]!)]) { _, numeric in numeric }
    }
    private func write(_ sql: String, binds: [String] = [], expected: ExpectedEvent) async throws {
        state.expected.append(expected); try save() // Independent intent before source action.
        try await source.execute(sql, binds.map(SQLValue.text))
    }
    private func insert(_ id: Int, _ value: String) async throws {
        var row = ["id": String(id), "value": value]
        if state.hasNote { row["note"] = "new" }
        state.rows.append(row); state.rows.sort { Int($0["id"]!)! < Int($1["id"]!)! }
        try await write("INSERT INTO poc.\(table) (id,value) VALUES (?,?)", binds: [String(id), value], expected: ExpectedEvent(type: "insert", table: table, data: rowJSON(row)))
    }
    private func update(_ value: String) async throws {
        let index = state.rows.firstIndex { $0["id"] == "1" }!
        state.previousRow = state.rows[index]
        state.rows[index]["value"] = value
        try await write("UPDATE poc.\(table) SET value=? WHERE id=1", binds: [value], expected: ExpectedEvent(type: "update", table: table, data: rowJSON(state.rows[index]), old: ["value": .string(state.previousRow["value"]!)]))
    }
    private func collect() async throws {
        let batch = try await pubsub.pull("cdc-audit")
        let dlq = try await pubsub.pull("cdc-dlq-observer")
        for message in batch {
            try PhaseOne.require(message.orderingKey == "mysql84", "Wrong audit ordering key")
            let id = try MaxwellEvent(data: message.data).identity(source: settings.sourceID)
            if let index = state.identities.firstIndex(of: id) {
                try PhaseOne.require(try ExactJSON(data: message.data) == ExactJSON(data: Data(state.payloads[index].utf8)), "Replay payload changed")
                state.duplicateAuditDeliveries += 1
            } else { state.identities.append(id); state.payloads.append(String(decoding: message.data, as: UTF8.self)) }
        }
        for message in dlq { state.dlq.append(try JSONDecoder().decode(QuarantineDiagnostic.self, from: message.data)) }
        try save()
        try await pubsub.ack("cdc-audit", ids: batch.map(\.ackID))
        try await pubsub.ack("cdc-dlq-observer", ids: dlq.map(\.ackID))
    }
    private func checkpoint() async throws -> String {
        try await target.execute("SELECT event_id FROM cdc_meta.checkpoints WHERE source_id=?", [.text(settings.sourceID)]).first?["event_id"] ?? ""
    }
    private func blockedInvariant() async throws {
        try PhaseOne.require(try await checkpoint() == state.blockedCheckpoint, "Blocked stream advanced checkpoint")
        try PhaseOne.require(try await target.query("SELECT event_id FROM cdc_meta.applied_events").count == state.blockedLedgerCount, "Blocked stream applied later events")
        let head = try await target.query("SELECT failure_id FROM cdc_meta.consumer_head")
        try PhaseOne.require(head.count == 1 && head[0]["failure_id"] != nil, "Blocked head disappeared")
        try PhaseOne.require(try await target.query("SELECT * FROM poc.\(table) WHERE id=1").isEmpty, "Poison event was silently skipped")
    }
    private func verifyDiagnostics() async throws {
        let groups = Dictionary(grouping: state.dlq, by: \.failureID)
        let unique = groups.values.compactMap(\.first)
        let expectedPoison = try state.expected.filter { event in
            guard let json = event.dataJSON else { return false }
            return try ExactJSON(data: Data(json.utf8)).object?["value"]?.string?.hasPrefix("poison-") == true
        }
        try PhaseOne.require(unique.count == state.expectedFailures && expectedPoison.count == state.expectedFailures, "Unexpected unique DLQ event count")
        try PhaseOne.require(Set(unique.compactMap(\.eventID)).count == state.expectedFailures, "DLQ identity missing or duplicated across quarantines")
        for diagnostic in unique {
            try PhaseOne.require(groups[diagnostic.failureID]!.allSatisfy { $0 == diagnostic }, "Republished diagnostic changed")
            try PhaseOne.require(diagnostic.sourceID == settings.sourceID && diagnostic.delivery.orderingKey == "mysql84" && !diagnostic.delivery.messageID.isEmpty, "DLQ envelope metadata mismatch")
            try PhaseOne.require(diagnostic.reason.contains("DML old primary key does not identify exactly one target row"), "Unexpected quarantine reason")
            let id = try MaxwellEvent(data: diagnostic.delivery.payload).identity(source: settings.sourceID)
            try PhaseOne.require(diagnostic.eventID == id, "DLQ source identity mismatch")
            guard let index = state.identities.firstIndex(of: id) else { throw POCError("DLQ event absent from independent audit") }
            try PhaseOne.require(diagnostic.delivery.payload == Data(state.payloads[index].utf8), "Quarantine lost original bytes")
            let event = try ExpectedEvent.observed(state.payloads[index])
            try PhaseOne.require(expectedPoison.contains(event), "Unexpected event quarantined")
        }
        let persisted = try await target.query("SELECT diagnostic FROM cdc_meta.quarantine")
        let stored = try persisted.map { try JSONDecoder().decode(QuarantineDiagnostic.self, from: Data($0["diagnostic"]!.utf8)) }
        try PhaseOne.require(stored.count == unique.count && stored.allSatisfy { unique.contains($0) }, "DLQ does not match durable quarantine")
    }
    private func blocked() async throws {
        let deadline = Date().addingTimeInterval(45)
        var ready = false
        while Date() < deadline {
            try await collect()
            let rows = try await target.query("SELECT published FROM cdc_meta.quarantine WHERE resolved=FALSE")
            if rows.count == 1 && rows[0]["published"] == "1" && Set(state.dlq.map(\.failureID)).count == state.expectedFailures { ready = true; break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try PhaseOne.require(ready, "Quarantine/publication did not complete")
        let drainUntil = Date().addingTimeInterval(3)
        while Date() < drainUntil {
            try await blockedInvariant(); try await collect()
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try await verifyDiagnostics()
    }
    private func verify() async throws {
        let deadline = Date().addingTimeInterval(90)
        var ready = false
        while Date() < deadline {
            try await collect()
            let ledger = try await target.query("SELECT event_id FROM cdc_meta.applied_events")
            if state.identities.count == state.expected.count && ledger.count == state.expected.count,
               try await target.query("SELECT * FROM cdc_meta.consumer_head").isEmpty {
                try HarnessAssertions.events(expected: state.expected, payloads: state.payloads, identities: state.identities, ledger: ledger.compactMap { $0["event_id"] })
                ready = true; break
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try PhaseOne.require(ready, "Recovery convergence timed out")
        let drainUntil = Date().addingTimeInterval(2)
        while Date() < drainUntil { try await collect(); try await Task.sleep(nanoseconds: 100_000_000) }
        try await verifyDiagnostics()
        let ledger = try await target.query("SELECT event_id,CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload FROM cdc_meta.applied_events ORDER BY event_id")
        try HarnessAssertions.events(expected: state.expected, payloads: state.payloads, identities: state.identities, ledger: ledger.compactMap { $0["event_id"] })
        for entry in ledger {
            let index = state.identities.firstIndex(of: entry["event_id"]!)!
            try PhaseOne.require(try ExactJSON(data: Data(entry["payload"]!.utf8)) == ExactJSON(data: Data(state.payloads[index].utf8)), "Ledger payload differs from audit")
        }
        try PhaseOne.require(try await checkpoint() == state.identities.last, "Wrong final applied checkpoint")
        var columns = [Column(name: "id", type: "int", nullable: false), Column(name: "value", type: "varchar(100)", nullable: false, collation: "utf8mb4_unicode_ci")]
        if state.hasNote { columns.append(Column(name: "note", type: "varchar(40)", nullable: false, defaultValue: "new", collation: "utf8mb4_unicode_ci")) }
        let expectedSchema = Schema(exists: true, collation: "utf8mb4_unicode_ci", engine: "InnoDB", columns: columns, indexes: [TableIndex(name: "PRIMARY", columns: ["id"], unique: true)])
        let a = try await source.schema(table: table), b = try await target.schema(table: table)
        try PhaseOne.require(a == expectedSchema && b == expectedSchema, "Recovery schema differs from model")
        let sourceRows = try await source.query("SELECT * FROM poc.\(table) ORDER BY id"), targetRows = try await target.query("SELECT * FROM poc.\(table) ORDER BY id")
        try HarnessAssertions.rows(expected: state.rows, source: sourceRows, target: targetRows, table: table)
        try PhaseOne.require(try await target.query("SELECT * FROM cdc_meta.ddl_journal WHERE completed=FALSE").isEmpty, "Pending DDL after recovery")
        let quarantine = try await target.query("SELECT * FROM cdc_meta.quarantine")
        try PhaseOne.require(quarantine.count == state.expectedFailures && quarantine.allSatisfy { $0["resolved"] == "1" && $0["published"] == "1" }, "Unresolved quarantine after recovery")
        try artifacts.save(ledger, "recovery-ledger.json"); try artifacts.save(quarantine, "recovery-quarantine.json")
        try artifacts.save(["expected": state.rows, "source": sourceRows, "target": targetRows], "recovery-rows.json")
        try artifacts.save(["expected": expectedSchema, "source": a, "target": b], "recovery-schema.json")
    }
}
