import Foundation
import ReplicationCore
import MySQLNIO
import NIOCore
import NIOPosix

public enum TargetFailure {
    public static func isTransient(_ error: Error) -> Bool {
        // Docker's embedded DNS can remove the service record while a stopped
        // database has no live network endpoint. Keep the head until it returns.
        if let address = error as? SocketAddressError, case .unknown = address { return true }
        if let sql = error as? MySQLError {
            switch sql {
            case .closed: return true
            case .server(let packet): return [1040, 1053, 1205, 1213, 2006, 2013].contains(Int(packet.errorCode.rawValue))
            default: return false
            }
        }
        return error is IOError || error is ChannelError || error is NIOConnectionError
    }
    public static func isPermanentEvent(_ error: Error) -> Bool {
        if isTransient(error) { return false }
        if error is POCError || error is DecodingError { return true }
        if let sql = error as? MySQLError {
            switch sql {
            case .server, .duplicateEntry, .invalidSyntax: return true
            default: return false
            }
        }
        return false
    }
}

public struct StreamHead {
    public let delivery: StoredDelivery
    public let failureID: String?
}

/// All methods run serially under Applier's connection-owned writer lock.
/// There is one global head: changing SOURCE_ID cannot bypass a blocked stream.
public final class RecoveryStore {
    private let db: Database
    private let source: String
    public init(db: Database, source: String) { self.db = db; self.source = source }
    public func initialize() async throws {
        try await db.query("CREATE TABLE IF NOT EXISTS cdc_meta.consumer_head (singleton TINYINT PRIMARY KEY, source_id VARCHAR(128) NOT NULL, envelope LONGTEXT NOT NULL, failure_id VARCHAR(36) NULL) ENGINE=InnoDB")
        try await db.query("CREATE TABLE IF NOT EXISTS cdc_meta.quarantine (failure_id VARCHAR(36) PRIMARY KEY, diagnostic LONGTEXT NOT NULL, published BOOLEAN NOT NULL DEFAULT FALSE, resolved BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), resolved_at TIMESTAMP(6) NULL) ENGINE=InnoDB")
        _ = try await head()
    }
    public func head() async throws -> StreamHead? {
        guard let row = try await db.query("SELECT source_id,envelope,failure_id FROM cdc_meta.consumer_head WHERE singleton=1").first else { return nil }
        guard row["source_id"] == source else { throw POCError("Persisted stream head belongs to another source; refusing to bypass it") }
        return StreamHead(delivery: try JSONDecoder().decode(StoredDelivery.self, from: Data(row["envelope"]!.utf8)), failureID: row["failure_id"])
    }
    public func retain(_ delivery: StoredDelivery) async throws {
        try await db.execute("INSERT INTO cdc_meta.consumer_head (singleton,source_id,envelope) VALUES (1,?,?)", [.text(source), .text(try encode(delivery))])
    }
    public func clear() async throws {
        try await db.query("DELETE FROM cdc_meta.consumer_head WHERE singleton=1 AND failure_id IS NULL")
    }
    public func quarantine(_ delivery: StoredDelivery, reason: String) async throws {
        let diagnostic = QuarantineDiagnostic(sourceID: source, delivery: delivery, reason: reason)
        try await db.query("START TRANSACTION")
        do {
            try await db.execute("INSERT INTO cdc_meta.quarantine (failure_id,diagnostic) VALUES (?,?)", [.text(diagnostic.failureID), .text(try encode(diagnostic))])
            try await db.execute("UPDATE cdc_meta.consumer_head SET failure_id=? WHERE singleton=1", [.text(diagnostic.failureID)])
            try await db.query("COMMIT")
        } catch { _ = try? await db.query("ROLLBACK"); throw error }
    }
    public func diagnostic(_ id: String) async throws -> (Data, Bool) {
        guard let row = try await db.execute("SELECT diagnostic,published FROM cdc_meta.quarantine WHERE failure_id=? AND resolved=FALSE", [.text(id)]).first else {
            throw POCError("Active quarantine record missing")
        }
        return (Data(row["diagnostic"]!.utf8), row["published"] == "1")
    }
    public func markPublished(_ id: String) async throws {
        try await db.execute("UPDATE cdc_meta.quarantine SET published=TRUE WHERE failure_id=?", [.text(id)])
    }
    public func resolve(_ id: String) async throws {
        try await db.query("START TRANSACTION")
        do {
            try await db.execute("UPDATE cdc_meta.quarantine SET resolved=TRUE,resolved_at=CURRENT_TIMESTAMP(6) WHERE failure_id=?", [.text(id)])
            try await db.execute("DELETE FROM cdc_meta.consumer_head WHERE singleton=1 AND failure_id=?", [.text(id)])
            try await db.query("COMMIT")
        } catch { _ = try? await db.query("ROLLBACK"); throw error }
    }
    private func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}
