import Testing
import GRPC
@testable import E2EHarness

@Test func observerRetriesTemporaryErrorsAndReturnsResult() async throws {
    var calls = 0, recorded: [Int] = [], delays: [UInt64] = []
    let value = try await ObserverRetry.call(operation: {
        calls += 1
        if calls < 3 { throw GRPCStatus(code: .deadlineExceeded, message: "test timeout") }
        return ["delivery"]
    }, onRetry: { attempt, _ in recorded.append(attempt) }, sleep: { delays.append($0) })
    #expect(value == ["delivery"])
    #expect(calls == 3)
    #expect(recorded == [1, 2])
    #expect(delays == [250_000_000, 500_000_000])
}

@Test func observerStopsAfterBoundedRetries() async {
    var calls = 0, recorded: [Int] = []
    do {
        let _: Void = try await ObserverRetry.call(operation: {
            calls += 1; throw GRPCStatus(code: .unavailable, message: "persistent outage")
        }, onRetry: { attempt, _ in recorded.append(attempt) }, sleep: { _ in })
        Issue.record("Persistent outage must fail")
    } catch { #expect((error as? GRPCStatus)?.code == .unavailable) }
    #expect(calls == 4)
    #expect(recorded == [1, 2, 3])
}

@Test func observerDoesNotRetryPermanentErrorsOrCancellation() async {
    for error in [GRPCStatus(code: .notFound, message: "missing subscription") as Error,
                  GRPCStatus(code: .permissionDenied, message: "denied"), CancellationError()] {
        var calls = 0, retries = 0
        do {
            let _: Void = try await ObserverRetry.call(operation: { calls += 1; throw error },
                onRetry: { _, _ in retries += 1 }, sleep: { _ in })
            Issue.record("Error must propagate")
        } catch {}
        #expect(calls == 1)
        #expect(retries == 0)
    }
}

@Test func observerCancellationDuringBackoffStopsRetrying() async {
    var calls = 0
    do {
        let _: Void = try await ObserverRetry.call(operation: {
            calls += 1; throw GRPCStatus(code: .deadlineExceeded, message: "timeout")
        }, onRetry: { _, _ in }, sleep: { _ in throw CancellationError() })
        Issue.record("Cancellation must propagate")
    } catch { #expect(error is CancellationError) }
    #expect(calls == 1)
}
