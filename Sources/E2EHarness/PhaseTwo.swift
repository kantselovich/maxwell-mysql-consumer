import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

public enum PhaseTwo {
    private static func require(_ condition: Bool, _ message: String) throws { try PhaseOne.require(condition, message) }
    private static func save<T: Encodable>(_ value: T, name: String, settings: Settings) throws {
        try FileManager.default.createDirectory(atPath: settings.artifacts, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: URL(fileURLWithPath: settings.artifacts + "/" + name))
    }

    public static func run(_ pubsub: PubSub, settings: Settings) async throws {
        let source = Database(), target = Database()
        do {
            try await PhaseOne.connect(source, host: settings.sourceHost)
            try await PhaseOne.connect(target, host: settings.targetHost)
            try require(try await target.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='poc'").isEmpty,
                        "Phase 2 requires an empty application target")
            let decimal = "12345678901234567890123456789012345.123456789012345678901234567890"
            // Each entry declares the independent expected CDC operations, including
            // rows later overwritten/deleted. Final table equality alone is insufficient.
            let workload: [(String, [String])] = [
                ("CREATE DATABASE poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", ["database-create:"]),
                ("CREATE TABLE poc.accounts (tenant INT, id BIGINT UNSIGNED, balance DECIMAL(65,30), label VARCHAR(100), raw VARBINARY(20), doc JSON, happened DATETIME(6), stamp TIMESTAMP(6) NULL, optional TEXT, PRIMARY KEY (tenant,id)) ENGINE=InnoDB", ["table-create:accounts"]),
                ("INSERT INTO poc.accounts VALUES (1,1,\(decimal),'你好 🐘 O''Brien',X'00FF5C27','{\"large\":18446744073709551615,\"a\":[null,true,\"é\"]}','2026-09-25 12:34:56.123456','2026-09-25 12:34:56.654321',NULL),(1,2,0,'delete me',X'','{}',NULL,NULL,'x'),(2,18446744073709551615,-\(decimal),'max unsigned',X'FF00','null',NULL,NULL,NULL)", ["insert:accounts", "insert:accounts", "insert:accounts"]),
                ("UPDATE poc.accounts SET id=10, label='key moved' WHERE tenant=1 AND id=1", ["update:accounts"]),
                ("UPDATE poc.accounts SET label='newest value 你好 🐘' WHERE tenant=1 AND id=10", ["update:accounts"]),
                ("DELETE FROM poc.accounts WHERE tenant=1 AND id=2", ["delete:accounts"]),
                ("ALTER TABLE poc.accounts ADD COLUMN note VARCHAR(80) NOT NULL DEFAULT 'new'", ["table-alter:accounts"]),
                ("UPDATE poc.accounts SET note='written immediately after DDL' WHERE tenant=1 AND id=10", ["update:accounts"]),
                ("INSERT INTO poc.accounts (tenant,id,label,note) VALUES (3,3,'after add','explicit')", ["insert:accounts"]),
                ("CREATE INDEX by_label ON poc.accounts (label)", ["table-alter:accounts"]),
                ("DROP INDEX by_label ON poc.accounts", ["table-alter:accounts"]),
                ("CREATE TABLE poc.scratch (id INT PRIMARY KEY, value VARCHAR(20)) ENGINE=InnoDB", ["table-create:scratch"]),
                ("INSERT INTO poc.scratch VALUES (1,'old')", ["insert:scratch"]),
                ("DROP TABLE poc.scratch", ["table-drop:scratch"]),
                ("CREATE TABLE poc.scratch (id INT PRIMARY KEY, changed INT) ENGINE=InnoDB", ["table-create:scratch"]),
                ("INSERT INTO poc.scratch VALUES (2,42)", ["insert:scratch"]),
                ("CREATE TABLE poc.marker (id INT PRIMARY KEY) ENGINE=InnoDB", ["table-create:marker"]),
                ("INSERT INTO poc.marker VALUES (1)", ["insert:marker"])
            ]
            for (sql, _) in workload { try await source.query(sql) }
            var expected = workload.flatMap(\.1)
            var ids: [String] = [], payloads: [String] = [], seen = Set<String>()
            try save(expected, name: "expected-events.json", settings: settings)
            try await converge(pubsub, target: target, settings: settings, expected: expected,
                               ids: &ids, payloads: &payloads, seen: &seen)
            try await compare(source, target, settings: settings)
            print("PASS source-only DDL, composite/changed keys, CRUD, exact data types, add-column, index, drop/recreate")

            // An old update must be deduplicated, not overwrite the later value.
            let oldUpdate = try payloads.first { try MaxwellEvent(data: Data($0.utf8)).type == "update" }!
            _ = try await pubsub.publish(topic: "cdc", data: Data(oldUpdate.utf8), key: "mysql84")
            try await source.query("INSERT INTO poc.marker VALUES (2)")
            expected.append("insert:marker")
            try await converge(pubsub, target: target, settings: settings, expected: expected,
                               ids: &ids, payloads: &payloads, seen: &seen)
            try await compare(source, target, settings: settings)
            // Bounded drain, repeatedly checking rather than a single empty pull.
            let drainUntil = Date().addingTimeInterval(3)
            while Date() < drainUntil {
                try require(try await pubsub.pull("cdc-dlq-observer").isEmpty, "Unexpected DLQ delivery")
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            try save(expected, name: "expected-events.json", settings: settings)
            try save(["uniqueEvents": ids.count, "dlqDeliveries": 0], name: "assertions.json", settings: settings)
            print("PASS old-update republication; \(ids.count) unique events reconciled with ledger; zero pending DDL/zero DLQ")
            await source.close(); await target.close()
        } catch { await source.close(); await target.close(); throw error }
    }

    private static func converge(_ pubsub: PubSub, target: Database, settings: Settings, expected: [String],
                                 ids: inout [String], payloads: inout [String], seen: inout Set<String>) async throws {
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            let batch = try await pubsub.pull("cdc-audit")
            for message in batch {
                try require(message.orderingKey == "mysql84", "Audit ordering key mismatch")
                let event = try MaxwellEvent(data: message.data)
                let id = try event.identity(source: settings.sourceID)
                if seen.insert(id).inserted { ids.append(id); payloads.append(String(decoding: message.data, as: UTF8.self)) }
            }
            try await pubsub.ack("cdc-audit", ids: batch.map(\.ackID))
            try save(payloads, name: "audit.json", settings: settings)
            try require(try await pubsub.pull("cdc-dlq-observer").isEmpty, "Unexpected DLQ delivery")
            let ledger = try await target.query("SELECT event_id FROM cdc_meta.applied_events ORDER BY event_id")
            try save(ledger, name: "ledger.json", settings: settings)
            if ids.count >= expected.count && ledger.count >= expected.count {
                let actual = try payloads.map { payload -> String in
                    let event = try MaxwellEvent(data: Data(payload.utf8))
                    return event.type + ":" + (event.table ?? "")
                }
                try require(actual == expected, "Expected event manifest differs from audit: \(actual)")
                try require(Set(ledger.compactMap { $0["event_id"] }) == Set(ids), "Audit/ledger identities differ")
                let pending = try await target.query("SELECT event_id FROM cdc_meta.ddl_journal WHERE completed=FALSE")
                try require(pending.isEmpty, "Unfinished DDL journal")
                let checkpoint = try await target.execute("SELECT event_id FROM cdc_meta.checkpoints WHERE source_id=?", [.text(settings.sourceID)])
                try require(checkpoint.first?["event_id"] == ids.last, "Checkpoint did not reach final marker")
                return
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw POCError("Convergence timeout: \(ids.count)/\(expected.count) audited; inspect ledger and consumer logs")
    }

    private static func compare(_ source: Database, _ target: Database, settings: Settings) async throws {
        for table in ["accounts", "scratch", "marker"] {
            let a = try await source.schema(table: table), b = try await target.schema(table: table)
            try save(a, name: "source-\(table)-schema.json", settings: settings)
            try save(b, name: "target-\(table)-schema.json", settings: settings)
            try require(a == b, "Semantic schema differs for \(table): \(try a.encoded()) != \(try b.encoded())")
            let sql: String
            if table == "accounts" {
                sql = "SELECT tenant,CAST(id AS CHAR) AS id,CAST(balance AS CHAR) AS balance,label,HEX(raw) AS raw,CAST(doc AS CHAR) AS doc,CAST(happened AS CHAR) AS happened,CAST(stamp AS CHAR) AS stamp,optional,note FROM poc.accounts ORDER BY tenant,id"
            } else { sql = "SELECT * FROM poc.\(table) ORDER BY id" }
            let rowsA = try await source.query(sql), rowsB = try await target.query(sql)
            try save(rowsA, name: "source-\(table)-rows.json", settings: settings)
            try save(rowsB, name: "target-\(table)-rows.json", settings: settings)
            try require(rowsA == rowsB, "Rows differ for \(table): \(rowsA) != \(rowsB)")
        }
    }

    /// Target integration checks; no Pub/Sub delivery claims are made by these
    /// injected exceptions. Real process crashes/ACK failures belong to Phase 4.
    public static func recovery(settings: Settings) async throws {
        var db = Database()
        do {
            try await PhaseOne.connect(db, host: settings.targetHost)
            var applier = Applier(db: db, source: "recovery-tests")
            try await applier.initialize()
            func ddl(_ position: Int, _ sql: String, type: String = "table-create") -> Data {
                Data(ExactJSON.object(["database": .string("poc"), "table": .string("recovery_probe"),
                                       "type": .string(type), "position": .string("test.000001:\(position)"), "sql": .string(sql)]).json.utf8)
            }
            func row(_ position: Int, id: Int, type: String = "insert") -> Data {
                Data(ExactJSON.object(["database": .string("poc"), "table": .string("recovery_probe"),
                                       "type": .string(type), "position": .string("test.000001:\(position)"),
                                       "xid": .number("1"), "commit": .bool(true),
                                       "primary_key_columns": .array([.string("id")]),
                                       "data": .object(["id": .number(String(id))])]).json.utf8)
            }
            struct Injected: Error {}
            let create = ddl(1, "CREATE TABLE poc.recovery_probe (id INT PRIMARY KEY) ENGINE=InnoDB")
            do { try await applier.apply(create, afterMutation: { throw Injected() }); throw POCError("Injection did not run") }
            catch is Injected {}
            try require(try await db.schema(table: "recovery_probe").exists, "DDL must survive simulated crash")
            // Reconnect and construct a new applier: recovery cannot depend on
            // an in-memory plan or the original connection's state/lock.
            await db.close()
            db = Database()
            try await PhaseOne.connect(db, host: settings.targetHost)
            applier = Applier(db: db, source: "recovery-tests")
            try await applier.initialize()
            try require(try await applier.apply(create), "DDL must complete from after-schema")
            try require(try await applier.apply(create) == false, "Completed DDL must deduplicate")

            let insert = row(2, id: 1)
            let checkpointBefore = try await db.query("SELECT * FROM cdc_meta.checkpoints WHERE source_id='recovery-tests'")
            do { try await applier.apply(insert, afterMutation: { throw Injected() }); throw POCError("Injection did not run") }
            catch is Injected {}
            try require(try await db.query("SELECT * FROM poc.recovery_probe").isEmpty, "DML must roll back before ledger commit")
            try require(try await db.query("SELECT * FROM cdc_meta.checkpoints WHERE source_id='recovery-tests'") == checkpointBefore, "Failed DML advanced checkpoint")
            try require(try await applier.apply(insert), "Retry must apply rolled-back DML")
            try require(try await applier.apply(insert) == false, "Committed DML must deduplicate")
            do { try await applier.apply(row(2, id: 999)); throw POCError("Collision was accepted") }
            catch let error as POCError { try require(error.description.contains("different payload"), "Wrong collision failure: \(error)") }

            let add = ddl(3, "ALTER TABLE poc.recovery_probe ADD COLUMN note INT", type: "table-alter")
            do { try await applier.apply(add, afterMutation: { throw Injected() }); throw POCError("Injection did not run") }
            catch is Injected {}
            try await db.query("ALTER TABLE poc.recovery_probe ADD COLUMN drift INT")
            do { try await applier.apply(add); throw POCError("Unexpected success") }
            catch let error as POCError { try require(error.description.contains("drift"), "Wrong drift failure: \(error)") }
            do { try await applier.apply(row(4, id: 2)); throw POCError("Pending DDL did not block later event") }
            catch let error as POCError { try require(error.description.contains("incomplete DDL"), "Wrong blocked-event failure") }
            try await db.query("ALTER TABLE poc.recovery_probe DROP COLUMN drift")
            try require(try await applier.apply(add), "DDL must finish after drift repair")
            try await applier.apply(ddl(5, "DROP TABLE poc.recovery_probe", type: "table-drop"))
            try save(["ddlRecovery": true, "dmlRollback": true, "deduplication": true, "collisionRejected": true,
                      "driftRejected": true, "pendingDDLBlocks": true], name: "recovery-assertions.json", settings: settings)
            print("PASS DDL recovery, DML rollback/checkpoint atomicity, deduplication, identity collision, schema drift and pending-DDL barrier")
            await db.close()
        } catch { await db.close(); throw error }
    }
}
