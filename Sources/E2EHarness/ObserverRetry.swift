import Foundation
import PubSubTransport

/// Retry one diagnostic RPC, never the workload or a completed observation batch.
/// Four attempts at the transport's five-second deadline remain bounded.
enum ObserverRetry {
    static func call<T>(
        operation: () async throws -> T,
        onRetry: (Int, Error) throws -> Void,
        sleep: (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
    ) async throws -> T {
        var retries = 0
        while true {
            try Task.checkCancellation()
            do { return try await operation() }
            catch {
                if error is CancellationError { throw error }
                try Task.checkCancellation()
                guard PubSub.isTransient(error), retries < 3 else { throw error }
                retries += 1
                try onRetry(retries, error)
                try await sleep(250_000_000 << (retries - 1))
            }
        }
    }
}
