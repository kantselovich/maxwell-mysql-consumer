import Foundation
import MySQLNIO
import NIOPosix
import ReplicationCore

public enum SQLValue {
    case null, text(String), bytes(Data)
}

/// One connection, deliberately used serially by the applier.
public final class Database {
    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private var connection: MySQLConnection?

    public init() {}

    public func connect(host: String, user: String, password: String) async throws {
        connection = try await MySQLConnection.connect(
            to: .makeAddressResolvingHost(host, port: 3306), username: user,
            database: "", password: password, tlsConfiguration: nil, on: group.next()
        ).get()
        try await query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
        try await query("SET time_zone = '+00:00'")
        try await query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,NO_BACKSLASH_ESCAPES'")
    }

    @discardableResult
    public func execute(_ sql: String, _ values: [SQLValue] = []) async throws -> [[String: String]] {
        guard let connection else { throw POCError("Database not connected") }
        let binds: [MySQLData] = values.map {
            switch $0 {
            case .null: return .null
            case .text(let text): return MySQLData(string: text)
            case .bytes(let bytes):
                var buffer = connection.channel.allocator.buffer(capacity: bytes.count)
                buffer.writeBytes(bytes)
                return MySQLData(type: .blob, format: .binary, buffer: buffer)
            }
        }
        let rows = try await connection.query(sql, binds).get()
        return rows.map { row in
            var result: [String: String] = [:]
            for column in row.columnDefinitions { result[column.name] = row.column(column.name)?.string }
            return result
        }
    }

    public func schema(database: String = "poc", table: String?) async throws -> Schema {
        if let table {
            let tables = try await execute("SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", [.text(database), .text(table)])
            guard let info = tables.first else { return Schema() }
            let rows = try await execute("SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [.text(database), .text(table)])
            let columns = rows.map { Column(name: $0["COLUMN_NAME"]!, type: $0["COLUMN_TYPE"]!, nullable: $0["IS_NULLABLE"] == "YES", defaultValue: $0["COLUMN_DEFAULT"], collation: $0["COLLATION_NAME"], extra: $0["EXTRA"] ?? "") }
            let indexRows = try await execute("SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SUB_PART, INDEX_TYPE, COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX", [.text(database), .text(table)])
            var indexes: [TableIndex] = []
            for row in indexRows {
                guard row["SUB_PART"] == nil, row["INDEX_TYPE"] == "BTREE", row["COLLATION"] == "A" else { throw POCError("Unsupported target index shape") }
                let name = row["INDEX_NAME"]!
                if let i = indexes.firstIndex(where: { $0.name == name }) { indexes[i].columns.append(row["COLUMN_NAME"]!) }
                else { indexes.append(TableIndex(name: name, columns: [row["COLUMN_NAME"]!], unique: row["NON_UNIQUE"] == "0")) }
            }
            return Schema(exists: true, collation: info["TABLE_COLLATION"], engine: info["ENGINE"], columns: columns, indexes: indexes)
        }
        let rows = try await execute("SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [.text(database)])
        return rows.first.map { Schema(exists: true, collation: $0["DEFAULT_COLLATION_NAME"]) } ?? Schema()
    }

    @discardableResult
    public func query(_ sql: String) async throws -> [[String: String]] {
        guard let connection else { throw NSError(domain: "DatabaseNotConnected", code: 1) }
        let rows = try await connection.simpleQuery(sql).get()
        return rows.map { row in
            var result: [String: String] = [:]
            for column in row.columnDefinitions {
                result[column.name] = row.column(column.name)?.string
            }
            return result
        }
    }

    public func close() async {
        try? await connection?.close().get()
        try? await group.shutdownGracefully()
    }
}
