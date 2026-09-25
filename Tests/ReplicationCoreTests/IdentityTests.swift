import Foundation
import Testing
@testable import ReplicationCore

@Test func rowsSharingPositionRemainDistinct() throws {
    let messages = [
        #"{"database":"poc","table":"t","type":"insert","position":"binlog.000001:200","xid":3,"xoffset":0}"#,
        #"{"database":"poc","table":"t","type":"insert","position":"binlog.000001:200","xid":3,"xoffset":1}"#,
        #"{"database":"poc","table":"t","type":"insert","position":"binlog.000001:200","xid":3,"commit":true}"#,
    ]
    let identities = try messages.map { try MaxwellEvent(data: Data($0.utf8)).identity(source: "source-1") }
    #expect(Set(identities).count == 3)
    #expect(identities[2].hasSuffix("/commit"))
}

@Test func incompleteMetadataFailsClosed() throws {
    let message = #"{"database":"poc","type":"update","position":"binlog.000001:200","xid":3}"#
    let event = try MaxwellEvent(data: Data(message.utf8))
    #expect(throws: POCError.self) { try event.identity(source: "source-1") }
}

@Test func sourceResetRequiresNewNamespace() throws {
    let event = try MaxwellEvent(data: Data(#"{"database":"poc","table":"t","type":"table-create","position":"binlog.000001:100"}"#.utf8))
    #expect(try event.identity(source: "history-1") != event.identity(source: "history-2"))
}
