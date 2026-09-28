import Foundation
import Testing
@testable import ReplicationCore

@Test func quarantinePreservesMalformedBytesAndStableDiagnostic() throws {
    let delivery = StoredDelivery(messageID: "message-1", orderingKey: "mysql84", payload: Data([0xff, 0x00, 0x7b]))
    let diagnostic = QuarantineDiagnostic(sourceID: "source", delivery: delivery, reason: "invalid JSON")
    let persisted = try JSONEncoder().encode(diagnostic)
    let decoded = try JSONDecoder().decode(QuarantineDiagnostic.self, from: persisted)
    #expect(decoded == diagnostic)
    #expect(decoded.delivery.payload == delivery.payload)
    #expect(decoded.eventID == nil)
    #expect(!decoded.failureID.isEmpty)
}

@Test func quarantineRetainsSourceIdentity() throws {
    let raw = Data(#"{"database":"poc","table":"t","type":"insert","position":"binlog.000001:123","xid":4,"commit":true,"data":{"id":1}}"#.utf8)
    let diagnostic = QuarantineDiagnostic(sourceID: "source", delivery: StoredDelivery(messageID: "m1", orderingKey: "mysql84", payload: raw), reason: "missing table")
    #expect(diagnostic.eventID == "source/binlog.000001:123/commit")
}

@Test func retryBackoffIsBounded() {
    #expect(RecoveryPolicy.delay(attempt: 0) == 250_000_000)
    #expect(RecoveryPolicy.delay(attempt: 1) == 500_000_000)
    #expect(RecoveryPolicy.delay(attempt: 100) == 5_000_000_000)
    #expect(RecoveryPolicy.delay(attempt: -1) == 250_000_000)
}
