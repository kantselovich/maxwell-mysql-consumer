import Foundation

public struct POCError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// Decode only metadata here; retain original bytes so numeric data is never rounded.
public struct MaxwellEvent: Decodable {
    public let database: String
    public let table: String?
    public let type: String
    public let position: String?
    public let xid: UInt64?
    public let xoffset: UInt64?
    public let commit: Bool?

    public init(data: Data) throws { self = try JSONDecoder().decode(Self.self, from: data) }

    /// Namespace must identify this source's binlog history (change it after a source reset).
    /// Maxwell omits xoffset on a transaction's final row, so use an explicit commit marker.
    public func identity(source: String) throws -> String {
        guard !source.isEmpty, let position, !position.isEmpty else {
            throw POCError("Event is missing source identity or binlog position")
        }
        let suffix: String
        switch type {
        case "insert", "update", "delete":
            guard xid != nil else { throw POCError("DML is missing xid") }
            if commit == true { suffix = "commit" }
            else if let xoffset { suffix = "row:\(xoffset)" }
            else { throw POCError("Non-final DML is missing xoffset") }
        case "database-create", "database-alter", "database-drop", "table-create", "table-alter", "table-drop":
            suffix = "ddl"
        default:
            throw POCError("Unsupported event type: \(type)")
        }
        return "\(source)/\(position)/\(suffix)"
    }
}
