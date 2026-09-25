import Foundation
import MySQLNIO
import NIOPosix

/// Shared connection primitive; replication writes are implemented in Phase 2.
public final class Database {
    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private var connection: MySQLConnection?

    public init() {}

    public func connect(host: String, user: String, password: String) async throws {
        connection = try await MySQLConnection.connect(
            to: .makeAddressResolvingHost(host, port: 3306), username: user,
            database: "", password: password, tlsConfiguration: nil, on: group.next()
        ).get()
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
