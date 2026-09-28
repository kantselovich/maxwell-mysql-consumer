import Foundation
import ReplicationCore

/// Serial, fail-closed applier. The caller may ACK only after apply returns.
/// A connection-level advisory lock prevents a second writer to this target.
public final class Applier {
    private let db: Database
    private let source: String
    private let database: String
    public init(db: Database, source: String, database: String = "poc") {
        self.db = db; self.source = source; self.database = database
    }
    public func initialize() async throws {
        _ = try quoteIdentifier(database)
        guard !source.isEmpty, source.utf8.count <= 128 else { throw POCError("Invalid source namespace") }
        let lock = try await db.execute("SELECT GET_LOCK(?, 0) AS acquired", [.text("cdc-applier-" + database)])
        guard lock.first?["acquired"] == "1" else { throw POCError("Another target applier owns the writer lock") }
        try await db.query("CREATE DATABASE IF NOT EXISTS cdc_meta CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
        try await db.query("CREATE TABLE IF NOT EXISTS cdc_meta.applied_events (event_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, payload LONGBLOB NOT NULL, applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB")
        try await db.query("CREATE TABLE IF NOT EXISTS cdc_meta.checkpoints (source_id VARCHAR(128) PRIMARY KEY, event_id VARCHAR(512) NOT NULL) ENGINE=InnoDB")
        try await db.query("CREATE TABLE IF NOT EXISTS cdc_meta.ddl_journal (event_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, payload LONGBLOB NOT NULL, before_schema LONGTEXT NOT NULL, after_schema LONGTEXT NOT NULL, completed BOOLEAN NOT NULL DEFAULT FALSE) ENGINE=InnoDB")
    }

    /// afterMutation is a test seam for a simulated process failure before ledger
    /// commit. DML rolls back; DDL is intentionally left for journal recovery.
    @discardableResult
    public func apply(_ payload: Data, afterMutation: (() async throws -> Void)? = nil) async throws -> Bool {
        let event = try MaxwellEvent(data: payload)
        guard event.database == database else { throw POCError("Event database out of scope") }
        let id = try event.identity(source: source)
        guard id.utf8.count <= 512, id.unicodeScalars.allSatisfy({ $0.isASCII }) else { throw POCError("Invalid event identity") }
        let root = try ExactJSON(data: payload)
        guard let object = root.object else { throw POCError("Event must be an object") }
        // Store a canonical full payload so identity reuse with changed contents is
        // visible. Metadata is stable in Maxwell replay (Phase 1 proves identity).
        let canonical = root.json
        let applied = try await db.execute("SELECT CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload FROM cdc_meta.applied_events WHERE event_id=?", [.text(id)])
        if let row = applied.first {
            guard row["payload"] == canonical else { throw POCError("Event identity reused with a different payload: \(id)") }
            return false
        }
        let pending = try await db.execute("SELECT event_id FROM cdc_meta.ddl_journal WHERE completed=FALSE")
        guard pending.allSatisfy({ $0["event_id"] == id }) else { throw POCError("An earlier incomplete DDL blocks this event") }
        if ["insert", "update", "delete"].contains(event.type) {
            try await db.query("START TRANSACTION")
            do {
                try await dml(event, object: object)
                try await afterMutation?()
                try await record(id, canonical)
                try await db.query("COMMIT")
            } catch {
                _ = try? await db.query("ROLLBACK")
                throw error
            }
        } else {
            guard let rawSQL = object["sql"]?.string else { throw POCError("DDL is missing SQL") }
            let plan = try DDLPolicy.parse(rawSQL, database: database, eventType: event.type, table: event.table)
            let current = try await db.schema(database: database, table: plan.table)
            let journal = try await db.execute("SELECT CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload, before_schema, after_schema FROM cdc_meta.ddl_journal WHERE event_id=?", [.text(id)])
            let before: Schema, after: Schema
            if let row = journal.first {
                guard row["payload"] == canonical else { throw POCError("DDL journal payload mismatch") }
                before = try JSONDecoder().decode(Schema.self, from: Data(row["before_schema"]!.utf8))
                after = try JSONDecoder().decode(Schema.self, from: Data(row["after_schema"]!.utf8))
            } else {
                if plan.table != nil {
                    let parent = try await db.schema(database: database, table: nil)
                    guard parent == Schema(exists: true, collation: "utf8mb4_unicode_ci") else { throw POCError("Application database must use utf8mb4_unicode_ci") }
                }
                before = current; after = try plan.after(current)
                try await db.execute("INSERT INTO cdc_meta.ddl_journal (event_id,payload,before_schema,after_schema) VALUES (?,?,?,?)",
                                     [.text(id), .text(canonical), .text(try before.encoded()), .text(try after.encoded())])
            }
            if current == before {
                try await db.query(plan.sql)
                try await afterMutation?()
            } else if current != after {
                throw POCError("DDL recovery found unrelated schema drift: \(id)")
            }
            let actual = try await db.schema(database: database, table: plan.table)
            guard actual == after else { throw POCError("DDL postcondition mismatch: expected \(try after.encoded()), got \(try actual.encoded())") }
            try await db.query("START TRANSACTION")
            do {
                try await record(id, canonical)
                try await db.execute("UPDATE cdc_meta.ddl_journal SET completed=TRUE WHERE event_id=?", [.text(id)])
                try await db.query("COMMIT")
            } catch { _ = try? await db.query("ROLLBACK"); throw error }
        }
        return true
    }

    private func record(_ id: String, _ payload: String) async throws {
        try await db.execute("INSERT INTO cdc_meta.applied_events (event_id,payload) VALUES (?,?)", [.text(id), .text(payload)])
        try await db.execute("INSERT INTO cdc_meta.checkpoints (source_id,event_id) VALUES (?,?) ON DUPLICATE KEY UPDATE event_id=VALUES(event_id)", [.text(source), .text(id)])
    }

    private func dml(_ event: MaxwellEvent, object: [String: ExactJSON]) async throws {
        guard let table = event.table, let data = object["data"]?.object else { throw POCError("DML requires table and row data") }
        let name = try quoteIdentifier(database) + "." + quoteIdentifier(table)
        let schema = try await db.schema(database: database, table: table)
        guard schema.exists, schema.engine == "InnoDB", !schema.primaryKey.isEmpty,
              Set(data.keys).isSubset(of: Set(schema.columns.map(\.name))),
              schema.columns.filter({ !$0.nullable }).allSatisfy({ data[$0.name] != nil }),
              object["primary_key_columns"] == .array(schema.primaryKey.map { .string($0) }) else {
            throw POCError("DML schema, full row image or primary-key metadata mismatch")
        }
        let columns = schema.columns
        let values = try columns.map { try bind(data[$0.name], column: $0) }
        let names = try columns.map { try quoteIdentifier($0.name) }
        if event.type == "insert" {
            try await db.execute("INSERT INTO \(name) (\(names.joined(separator: ","))) VALUES (\(Array(repeating: "?", count: values.count).joined(separator: ",")))", values)
        } else {
            let old: [String: ExactJSON]
            if event.type == "update" {
                guard let prior = object["old"]?.object, Set(prior.keys).isSubset(of: Set(columns.map(\.name))) else { throw POCError("UPDATE requires valid old values") }
                old = prior
            } else { old = [:] }
            let keys = try schema.primaryKey.map { key -> SQLValue in
                let value = old[key] ?? data[key]!
                guard value != .null else { throw POCError("NULL primary key") }
                return try bind(value, column: columns.first { $0.name == key }!)
            }
            let predicate = try schema.primaryKey.map { try quoteIdentifier($0) + "=?" }.joined(separator: " AND ")
            let existing = try await db.execute("SELECT 1 AS present FROM \(name) WHERE \(predicate) FOR UPDATE", keys)
            guard existing.count == 1 else { throw POCError("DML old primary key does not identify exactly one target row") }
            if event.type == "update" {
                try await db.execute("UPDATE \(name) SET \(names.map { $0 + "=?" }.joined(separator: ",")) WHERE \(predicate)", values + keys)
            } else {
                try await db.execute("DELETE FROM \(name) WHERE \(predicate)", keys)
            }
        }
    }
    private func bind(_ value: ExactJSON?, column: Column) throws -> SQLValue {
        // Wire contract: binlog_row_image=FULL and Maxwell output_nulls=false.
        // Missing field = SQL NULL, explicit null in a JSON column = JSON null.
        guard let value else { return .null }
        if column.type == "json" { return .text(value.json) }
        guard value != .null else { throw POCError("Explicit SQL NULL violates output_nulls=false wire contract") }
        if column.binary {
            guard let text = value.string, let data = Data(base64Encoded: text) else { throw POCError("Invalid Maxwell binary value") }
            return .bytes(data)
        }
        switch value {
        case .number(let text), .string(let text): return .text(text)
        case .bool(let value): return .text(value ? "1" : "0")
        default: throw POCError("Unsupported value for \(column.name)")
        }
    }
}
