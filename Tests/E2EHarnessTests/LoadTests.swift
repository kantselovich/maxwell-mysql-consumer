import Testing
@testable import E2EHarness

@Test func loadPercentilesUseNearestRank() {
    #expect(LoadStatistics.percentile([], 0.95) == 0)
    #expect(LoadStatistics.percentile([7], 0.99) == 7)
    #expect(LoadStatistics.percentile([4, 1, 3, 2], 0.5) == 2)
    #expect(LoadStatistics.percentile([4, 1, 3, 2], 0.95) == 4)
    #expect(LoadStatistics.percentile((1...100).map(Double.init), 0.99) == 99)
}

@Test func transactionChecksRejectWrongXIDOffsetAndBoundary() throws {
    let first = #"{"database":"poc","table":"a","type":"insert","xid":7,"xoffset":0}"#
    let last = #"{"database":"poc","table":"b","type":"insert","xid":7,"commit":true}"#
    try TransactionAssertions.ordered([first, last])
    for invalid in [[first, last.replacingOccurrences(of: "7", with: "8")],
                    [first.replacingOccurrences(of: "0", with: "1"), last],
                    [first, last.replacingOccurrences(of: "true", with: "false")],
                    [last, first], []] {
        #expect(throws: (any Error).self) { try TransactionAssertions.ordered(invalid) }
    }
}
