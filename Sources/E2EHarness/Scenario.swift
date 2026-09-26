import Foundation
import ReplicationCore

public struct HarnessFailure: Error, Codable, CustomStringConvertible {
    public let code: String
    public let description: String
    public init(_ code: String, _ description: String) { self.code = code; self.description = description }
}

public struct HarnessConfiguration: Codable {
    public let scenario: String
    public let rows: Int
    public let seed: UInt64
    public let writeIntervalMS: Int
    public let timeoutSeconds: Int
    public let drainSeconds: Int
    public let fault: String
    public let runID: String
    public init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        scenario = environment["SCENARIO"] ?? "smoke"
        fault = environment["HARNESS_FAULT"] ?? "none"
        guard ["smoke", "append", "crud", "schema-change"].contains(scenario),
              ["none", "missing-event", "wrong-value"].contains(fault),
              fault == "none" || scenario == "crud" else {
            throw HarnessFailure("configuration", "Unknown scenario/fault; fault injection requires SCENARIO=crud")
        }
        func integer(_ name: String, _ fallback: Int, _ range: ClosedRange<Int>) throws -> Int {
            guard let value = Int(environment[name] ?? String(fallback)), range.contains(value) else {
                throw HarnessFailure("configuration", "\(name) must be in \(range)")
            }
            return value
        }
        rows = try integer("ROWS", 12, 2...5000)
        writeIntervalMS = try integer("WRITE_INTERVAL_MS", 10, 0...10000)
        timeoutSeconds = try integer("CONVERGENCE_TIMEOUT", 60, 1...600)
        drainSeconds = try integer("DRAIN_SECONDS", 2, 1...30)
        guard let seed = UInt64(environment["SEED"] ?? "42") else { throw HarnessFailure("configuration", "SEED must be UInt64") }
        self.seed = seed
        runID = environment["RUN_ID"] ?? String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
        guard runID.range(of: #"^[a-z0-9]{1,16}$"#, options: .regularExpression) != nil else {
            throw HarnessFailure("configuration", "RUN_ID must contain 1–16 lowercase ASCII letters/digits")
        }
    }
    public var scenarios: [String] { scenario == "smoke" ? ["append", "crud", "schema-change"] : [scenario] }
}

/// Generated from the intended workload, never inferred from received events or
/// the final database. JSON strings retain exact types and numeric spelling.
public struct ExpectedEvent: Codable, Equatable {
    public var type: String
    public var table: String?
    public var dataJSON: String?
    public var oldJSON: String?
    public var ddlSQL: String?
    public init(type: String, table: String? = nil, data: [String: ExactJSON]? = nil,
                old: [String: ExactJSON]? = nil, sql: String? = nil) {
        self.type = type; self.table = table
        dataJSON = data.map { ExactJSON.object($0).json }
        oldJSON = old.map { ExactJSON.object($0).json }
        ddlSQL = sql
    }
    public static func observed(_ payload: String) throws -> ExpectedEvent {
        let bytes = Data(payload.utf8), event = try MaxwellEvent(data: bytes)
        guard event.database == "poc", let root = try ExactJSON(data: bytes).object else {
            throw HarnessFailure("event-manifest", "Unexpected event database or shape")
        }
        if let sql = root["sql"]?.string {
            let plan = try DDLPolicy.parse(sql, eventType: event.type, table: event.table)
            return ExpectedEvent(type: event.type, table: event.table, sql: plan.sql)
        }
        guard let data = root["data"]?.object else { throw HarnessFailure("event-manifest", "Missing event data") }
        return ExpectedEvent(type: event.type, table: event.table, data: data, old: root["old"]?.object)
    }
    public func normalized() throws -> ExpectedEvent {
        var result = self
        if let ddlSQL { result.ddlSQL = try DDLPolicy.parse(ddlSQL, eventType: type, table: table).sql }
        return result
    }
}

public struct WorkloadStep: Codable {
    public var sql: String
    public var bindings: [String] = []
    public var expected: ExpectedEvent
    /// Skipped only by the negative harness self-test. Insert and delete cancel
    /// in final state, so only independent event accounting detects their loss.
    public var ephemeral = false
}
public struct ExpectedTable: Codable {
    public var name: String
    public var schema: Schema
    public var rows: [[String: String]]
}
public struct ScenarioPlan: Codable {
    public var name: String
    public var steps: [WorkloadStep]
    public var table: ExpectedTable
}

public enum Scenarios {
    public static func baseSchema() -> Schema {
        Schema(exists: true, collation: "utf8mb4_unicode_ci", engine: "InnoDB",
               columns: [Column(name: "id", type: "int", nullable: false),
                         Column(name: "value", type: "varchar(80)", nullable: false, collation: "utf8mb4_unicode_ci")],
               indexes: [TableIndex(name: "PRIMARY", columns: ["id"], unique: true)])
    }
    public static func build(_ name: String, configuration config: HarnessConfiguration) -> ScenarioPlan {
        let table = "h_\(config.runID)_" + name.replacingOccurrences(of: "-", with: "_")
        let qualified = "poc.`\(table)`"
        var steps: [WorkloadStep] = [], rows: [Int: [String: String]] = [:], schema = baseSchema()
        var state = config.seed
        func nextValue() -> String {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return "v_\(state % 1_000_000)"
        }
        func row(_ id: Int) -> [String: ExactJSON] {
            var data = rows[id]!.mapValues { ExactJSON.string($0) }
            data["id"] = .number(String(id)); return data
        }
        func ddl(_ sql: String, _ type: String) {
            steps.append(WorkloadStep(sql: sql, expected: ExpectedEvent(type: type, table: table, sql: sql)))
        }
        ddl("CREATE TABLE \(qualified) (id INT PRIMARY KEY, value VARCHAR(80) NOT NULL) ENGINE=InnoDB", "table-create")
        for id in 1...config.rows {
            if name == "schema-change" && id == config.rows / 2 + 1 {
                ddl("ALTER TABLE \(qualified) ADD COLUMN note VARCHAR(80) NOT NULL DEFAULT 'new'", "table-alter")
                schema.columns.append(Column(name: "note", type: "varchar(80)", nullable: false, defaultValue: "new", collation: "utf8mb4_unicode_ci"))
                for key in Array(rows.keys) { rows[key]!["note"] = "new" }
                rows[1]!["note"] = "immediately after DDL 🐘"
                steps.append(WorkloadStep(sql: "UPDATE \(qualified) SET note=? WHERE id=1", bindings: [rows[1]!["note"]!],
                    expected: ExpectedEvent(type: "update", table: table, data: row(1), old: ["note": .string("new")])))
            }
            rows[id] = ["id": String(id), "value": nextValue()]
            var sql = "INSERT INTO \(qualified) (id,value) VALUES (?,?)", binds = [String(id), rows[id]!["value"]!]
            if schema.columns.count == 3 {
                rows[id]!["note"] = "after_\(id)"; binds.append(rows[id]!["note"]!)
                sql = "INSERT INTO \(qualified) (id,value,note) VALUES (?,?,?)"
            }
            steps.append(WorkloadStep(sql: sql, bindings: binds, expected: ExpectedEvent(type: "insert", table: table, data: row(id))))
        }
        if name == "crud" {
            for value in ["intermediate", "final 你好 🐘"] {
                let previous = rows[1]!["value"]!; rows[1]!["value"] = value
                steps.append(WorkloadStep(sql: "UPDATE \(qualified) SET value=? WHERE id=1", bindings: [value],
                    expected: ExpectedEvent(type: "update", table: table, data: row(1), old: ["value": .string(previous)])))
            }
            steps.append(WorkloadStep(sql: "DELETE FROM \(qualified) WHERE id=2", expected: ExpectedEvent(type: "delete", table: table, data: row(2))))
            rows.removeValue(forKey: 2)
            let id = config.rows + 1
            rows[id] = ["id": String(id), "value": "ephemeral"]
            steps.append(WorkloadStep(sql: "INSERT INTO \(qualified) VALUES (?,?)", bindings: [String(id), "ephemeral"],
                                     expected: ExpectedEvent(type: "insert", table: table, data: row(id)), ephemeral: true))
            steps.append(WorkloadStep(sql: "DELETE FROM \(qualified) WHERE id=?", bindings: [String(id)],
                                     expected: ExpectedEvent(type: "delete", table: table, data: row(id)), ephemeral: true))
            rows.removeValue(forKey: id)
        }
        // Keep an index in final state so semantic comparison checks its shape.
        ddl("CREATE INDEX by_value ON \(qualified) (value)", "table-alter")
        schema.indexes.append(TableIndex(name: "by_value", columns: ["value"]))
        schema.indexes.sort { $0.name < $1.name }
        return ScenarioPlan(name: name, steps: steps,
                            table: ExpectedTable(name: table, schema: schema, rows: rows.keys.sorted().map { rows[$0]! }))
    }
}

public enum HarnessAssertions {
    public static func events(expected: [ExpectedEvent], payloads: [String], identities: [String], ledger: [String]) throws {
        let actual = try payloads.map(ExpectedEvent.observed)
        let normalized = try expected.map { try $0.normalized() }
        guard actual == normalized else {
            let first = zip(normalized, actual).enumerated().first { $0.element.0 != $0.element.1 }?.offset
            throw HarnessFailure("event-manifest", "Expected \(expected.count) operations, observed \(actual.count); first mismatch at \(first.map(String.init) ?? String(min(actual.count, expected.count)))")
        }
        guard identities.count == payloads.count, Set(identities).count == identities.count, Set(ledger).count == ledger.count,
              Set(identities) == Set(ledger) else { throw HarnessFailure("event-ledger", "Audit identities and apply ledger differ") }
    }
    public static func rows(expected: [[String: String]], source: [[String: String]], target: [[String: String]], table: String) throws {
        guard source == expected, target == expected else { throw HarnessFailure("row-mismatch", "Rows differ from workload model for \(table)") }
    }
}
