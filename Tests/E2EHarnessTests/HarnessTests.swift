import Foundation
import Testing
import ReplicationCore
@testable import E2EHarness

@Test func seedIsRepeatableAndChangesValues() throws {
    let a = try HarnessConfiguration(environment: ["RUN_ID": "test", "SEED": "42", "ROWS": "4"])
    let b = try HarnessConfiguration(environment: ["RUN_ID": "test", "SEED": "43", "ROWS": "4"])
    let first = Scenarios.build("crud", configuration: a), again = Scenarios.build("crud", configuration: a)
    #expect(first.steps.map(\.expected) == again.steps.map(\.expected))
    #expect(first.steps.map(\.expected) != Scenarios.build("crud", configuration: b).steps.map(\.expected))
    #expect(first.steps.filter(\.ephemeral).count == 2)
    #expect(!first.table.rows.contains { $0["value"] == "ephemeral" })
}
@Test func rejectsInvalidHarnessConfiguration() {
    for env in [["SCENARIO": "typo"], ["ROWS": "0"], ["SEED": "-1"], ["RUN_ID": "../oops"],
                ["HARNESS_FAULT": "wrong-value"], ["CONVERGENCE_TIMEOUT": "0"], ["DRAIN_SECONDS": "0"]] {
        #expect(throws: (any Error).self) { try HarnessConfiguration(environment: env) }
    }
}
@Test func expectedSchemaTracksAddColumnAndFinalIndex() throws {
    let config = try HarnessConfiguration(environment: ["RUN_ID": "test", "ROWS": "4"])
    let plan = Scenarios.build("schema-change", configuration: config)
    #expect(plan.table.schema.columns.last?.name == "note")
    #expect(plan.table.schema.indexes.contains { $0.name == "by_value" })
    #expect(plan.table.rows[0]["note"] == "immediately after DDL 🐘")
    #expect(plan.table.rows[1]["note"] == "new")
    #expect(plan.table.rows[2]["note"] == "after_3")
    let alter = plan.steps.firstIndex { $0.expected.type == "table-alter" }!
    #expect(plan.steps[alter + 1].expected.type == "update")
}
@Test func missingIntermediateEventCannotHideBehindFinalRows() throws {
    let insert = ExpectedEvent(type: "insert", table: "t", data: ["id": .number("1"), "value": .string("temporary")])
    let delete = ExpectedEvent(type: "delete", table: "t", data: ["id": .number("1"), "value": .string("temporary")])
    try HarnessAssertions.rows(expected: [], source: [], target: [], table: "t")
    #expect(throws: (any Error).self) {
        try HarnessAssertions.events(expected: [insert, delete], payloads: [], identities: [], ledger: [])
    }
}
@Test func payloadValuesAndLedgerMembershipMatter() throws {
    let payload = #"{"database":"poc","table":"t","type":"insert","data":{"id":1,"value":"ok"}}"#
    let expected = ExpectedEvent(type: "insert", table: "t", data: ["id": .number("1"), "value": .string("ok")])
    try HarnessAssertions.events(expected: [expected], payloads: [payload], identities: ["event"], ledger: ["event"])
    #expect(throws: (any Error).self) {
        try HarnessAssertions.events(expected: [expected], payloads: [payload.replacingOccurrences(of: "ok", with: "wrong")], identities: ["event"], ledger: ["event"])
    }
    #expect(throws: (any Error).self) {
        try HarnessAssertions.events(expected: [expected], payloads: [payload], identities: ["event"], ledger: [])
    }
    #expect(throws: (any Error).self) {
        try HarnessAssertions.events(expected: [expected], payloads: [payload], identities: [], ledger: [])
    }
    #expect(throws: (any Error).self) {
        try HarnessAssertions.rows(expected: [["id": "1", "value": "ok"]], source: [["id": "1", "value": "ok"]], target: [["id": "1", "value": "wrong"]], table: "t")
    }
}
