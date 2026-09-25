import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

public struct Settings {
    public let sourceHost = ProcessInfo.processInfo.environment["SOURCE_HOST"] ?? "mysql84"
    public let targetHost = ProcessInfo.processInfo.environment["TARGET_HOST"] ?? "mysql57"
    public let pubsubHost = ProcessInfo.processInfo.environment["PUBSUB_HOST"] ?? "pubsub"
    public let sourceID = "local-mysql84-history-1"
    public let artifacts = ProcessInfo.processInfo.environment["ARTIFACT_DIR"] ?? "/artifacts"
    public init() {}
}

public struct Capture: Codable {
    public let table: String
    public let startPosition: String
    public let sourceVersion: String
    public let targetVersion: String
    public let identities: [String]
    public let payloads: [String]
}

public enum PhaseOne {
    public static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw POCError(message) }
    }

    public static func connect(_ db: Database, host: String) async throws {
        try await db.connect(host: host, user: "cdc", password: "cdc-local-only")
    }

    public static func initialize(_ pubsub: PubSub) async throws {
        for topic in ["cdc", "cdc-dlq", "transport-probe"] { try await pubsub.createTopic(topic) }
        for (name, topic) in [("cdc-consumer", "cdc"), ("cdc-audit", "cdc"),
                              ("cdc-diagnostic", "cdc"), ("cdc-dlq-observer", "cdc-dlq")] {
            try await pubsub.createSubscription(name, topic: topic)
        }
    }

    public static func transportProbe(_ pubsub: PubSub) async throws {
        let name = "transport-" + UUID().uuidString.lowercased()
        try await pubsub.createSubscription(name, topic: "transport-probe")
        let payload = Data("swift-publish-redelivery".utf8)
        let messageID = try await pubsub.publish(topic: "transport-probe", data: payload, key: "probe")
        let first = try await next(pubsub, subscription: name)
        try require(first.messageID == messageID && first.data == payload, "Swift publish/pull mismatch")
        try await pubsub.deadline(name, ids: [first.ackID], seconds: 30)
        try await pubsub.deadline(name, ids: [first.ackID], seconds: 0)
        let again = try await next(pubsub, subscription: name)
        try require(again.messageID == messageID && again.data == payload, "Redelivery changed message")
        try await pubsub.ack(name, ids: [again.ackID])
        try await pubsub.deleteSubscription(name)
        print("PASS Swift Pub/Sub create/get/publish/pull/extend/nack/redeliver/ack/delete")
    }

    private static func next(_ pubsub: PubSub, subscription: String) async throws -> Delivery {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if let message = try await pubsub.pull(subscription, max: 1).first { return message }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw POCError("Timed out waiting for \(subscription)")
    }

    private static func collect(_ pubsub: PubSub, subscription: String, table: String,
                                settings: Settings) async throws -> ([String], [String]) {
        var identities: [String] = [], payloads: [String] = [], seen = Set<String>()
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline && identities.count < 7 {
            let batch = try await pubsub.pull(subscription)
            for message in batch {
                let event = try MaxwellEvent(data: message.data)
                if event.database == "poc" && event.table == table {
                    try require(message.orderingKey == "mysql84", "Missing or incorrect ordering key")
                    let identity = try event.identity(source: settings.sourceID)
                    if seen.insert(identity).inserted {
                        identities.append(identity)
                        payloads.append(String(decoding: message.data, as: UTF8.self))
                    }
                }
            }
            try await pubsub.ack(subscription, ids: batch.map(\.ackID))
            if batch.isEmpty { try await Task.sleep(nanoseconds: 200_000_000) }
        }
        try require(identities.count == 7, "Expected 7 distinct table events; received \(identities.count): \(payloads)")
        let events = try payloads.map { try MaxwellEvent(data: Data($0.utf8)) }
        try require(events.map(\.type) == ["table-create", "insert", "insert", "insert", "update", "update", "delete"],
                    "DDL/DML order is incorrect: \(events.map(\.type))")
        // Assert payloads too: swapping two updates must not pass just because their types match.
        let rows = try payloads.dropFirst().map { payload -> [String: Any] in
            let object = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as! [String: Any]
            return object["data"] as! [String: Any]
        }
        try require(rows.compactMap { ($0["id"] as? NSNumber)?.intValue } == [1, 2, 3, 1, 1, 3], "Row order mismatch")
        try require(rows.compactMap { $0["value"] as? String } == ["first", "second", "third", "changed", "changed-again", "third"],
                    "CDC values or update order mismatch")
        try require(events[1].position == events[2].position && events[2].position == events[3].position,
                    "Fixture did not exercise multiple rows from one binlog event")
        return (identities, payloads)
    }

    public static func capture(_ pubsub: PubSub, settings: Settings) async throws {
        let source = Database(), target = Database()
        do {
            try await connect(source, host: settings.sourceHost)
            try await connect(target, host: settings.targetHost)
            let sourceVersion = try await source.query("SELECT VERSION() AS version")[0]["version"]!
            let targetVersion = try await target.query("SELECT VERSION() AS version")[0]["version"]!
            try require(sourceVersion.hasPrefix("8.4."), "Wrong source version: \(sourceVersion)")
            try require(targetVersion.hasPrefix("5.7."), "Wrong target version: \(targetVersion)")
            try await transportProbe(pubsub)
            let table = "probe_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            try await pubsub.createSubscription("phase1-capture-\(table)", topic: "cdc")
            try await source.query("CREATE DATABASE IF NOT EXISTS poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            let position = try await source.query("SHOW BINARY LOG STATUS")[0]
            let startPosition = "\(position["File"]!):\(position["Position"]!)"
            try await source.query("CREATE TABLE poc.\(table) (id INT PRIMARY KEY, value VARCHAR(100) NOT NULL) ENGINE=InnoDB")
            try await source.query("INSERT INTO poc.\(table) VALUES (1, 'first'), (2, 'second'), (3, 'third')")
            try await source.query("START TRANSACTION")
            try await source.query("UPDATE poc.\(table) SET value='changed' WHERE id=1")
            try await source.query("UPDATE poc.\(table) SET value='changed-again' WHERE id=1")
            try await source.query("COMMIT")
            try await source.query("DELETE FROM poc.\(table) WHERE id=3")
            let (identities, payloads) = try await collect(pubsub, subscription: "phase1-capture-\(table)", table: table, settings: settings)
            let targetTables = try await target.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='poc'")
            try require(targetTables.isEmpty, "Phase 1 must not provision replicated tables on target")
            let capture = Capture(table: table, startPosition: startPosition, sourceVersion: sourceVersion,
                                  targetVersion: targetVersion, identities: identities, payloads: payloads)
            try FileManager.default.createDirectory(atPath: settings.artifacts, withIntermediateDirectories: true)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(capture).write(to: URL(fileURLWithPath: settings.artifacts + "/capture.json"))
            // Only replayed publications should appear here.
            try await pubsub.createSubscription("phase1-replay-\(table)", topic: "cdc")
            try await pubsub.deleteSubscription("phase1-capture-\(table)")
            print("PASS MySQL \(sourceVersion) → Maxwell → ordered Pub/Sub → Swift: 7 events; target \(targetVersion) connected")
            await source.close(); await target.close()
        } catch {
            await source.close(); await target.close(); throw error
        }
    }

    public static func loadCapture(_ settings: Settings) throws -> Capture {
        try JSONDecoder().decode(Capture.self, from: Data(contentsOf: URL(fileURLWithPath: settings.artifacts + "/capture.json")))
    }

    public static func verifyReplay(_ pubsub: PubSub, settings: Settings) async throws {
        let capture = try loadCapture(settings)
        let (identities, payloads) = try await collect(pubsub, subscription: "phase1-replay-\(capture.table)", table: capture.table, settings: settings)
        try require(identities == capture.identities, "Source event identities changed across Maxwell replay")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(payloads).write(to: URL(fileURLWithPath: settings.artifacts + "/replay.json"))
        try await pubsub.deleteSubscription("phase1-replay-\(capture.table)")
        try require(try await pubsub.pull("cdc-dlq-observer").isEmpty, "Unexpected DLQ message")
        print("PASS real Maxwell binlog replay: all 7 identities and ordering preserved; DLQ empty")
    }
}
