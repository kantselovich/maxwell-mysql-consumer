import Foundation
import ReplicationCore
import MySQLTarget
import PubSubTransport

private func log(_ state: String, _ details: String = "") {
    let data = try! JSONSerialization.data(withJSONObject: ["state": state, "details": details], options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

private actor LeaseStatus {
    var failure: Error?
    func set(_ error: Error?) { failure = error }
    func check() throws { if let failure { throw failure } }
}

/// Independent of SQL/retry waits. A crash leaves at most a short lease, while
/// a live consumer renews indefinitely during a prolonged target outage.
private final class Lease {
    let status = LeaseStatus()
    var task: Task<Void, Never>?
    init(pubsub: PubSub, delivery: Delivery) async throws {
        try await pubsub.deadline("cdc-consumer", ids: [delivery.ackID], seconds: 10)
        task = Task { [status] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                    try await pubsub.deadline("cdc-consumer", ids: [delivery.ackID], seconds: 10)
                    await status.set(nil)
                    log("LEASE_RENEWED", delivery.messageID)
                } catch is CancellationError { return }
                catch { await status.set(error); log("LEASE_ERROR", String(describing: error)) }
            }
        }
    }
    func stop() async { task?.cancel(); await task?.value }
}

/// Test-only pause points. The host kills the real process while it is paused.
/// An armed request is consumed once on a mounted test volume, across restarts.
private enum FaultGate {
    static func hit(_ point: String, payload: Data) async throws {
        guard ProcessInfo.processInfo.environment["ENABLE_FAULT_INJECTION"] == "1" else { return }
        let request = URL(fileURLWithPath: "/faults/request.json")
        guard FileManager.default.fileExists(atPath: request.path) else { return }
        let value = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: request))
        let event = try MaxwellEvent(data: payload)
        guard value["point"] == point, value["table"] == event.table, value["type"] == event.type else { return }
        try FileManager.default.removeItem(at: request)
        try JSONEncoder().encode(value).write(to: URL(fileURLWithPath: "/faults/reached.json"), options: .atomic)
        log("FAULT_PAUSED", point)
        while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
    }
}

public final class ConsumerLoop {
    private let pubsub: PubSub
    private let targetHost: String
    private let sourceID: String
    private var db: Database?
    private var applier: Applier?
    private var store: RecoveryStore?
    public init(pubsub: PubSub, targetHost: String, sourceID: String) {
        self.pubsub = pubsub; self.targetHost = targetHost; self.sourceID = sourceID
    }
    private func connect() async throws {
        if db != nil { return }
        let candidate = Database()
        do {
            try await candidate.connect(host: targetHost, user: "cdc", password: "cdc-local-only")
            let writer = Applier(db: candidate, source: sourceID)
            try await writer.initialize()
            let recovery = RecoveryStore(db: candidate, source: sourceID)
            try await recovery.initialize()
            db = candidate; applier = writer; store = recovery
            log("READY", sourceID)
        } catch { await candidate.close(); throw error }
    }
    private func disconnect() async {
        await db?.close(); db = nil; applier = nil; store = nil
    }
    public func run() async throws {
        var current: Delivery?
        var lease: Lease?
        var attempt = 0
        var reportedBlock: String?
        do {
            while !Task.isCancelled {
                do {
                    // Never auto-create missing resources: that could hide emulator queue loss.
                    try await pubsub.checkSubscription("cdc-consumer")
                    try await pubsub.checkSubscription("cdc-dlq-observer")
                    try await lease?.status.check()
                    try await connect()
                    let recovery = store!, writer = applier!
                    if let head = try await recovery.head() {
                        if let current {
                            guard head.delivery == StoredDelivery(messageID: current.messageID, orderingKey: current.orderingKey, payload: current.data) else {
                                throw POCError("In-memory delivery does not match durable stream head")
                            }
                        }
                        if let failure = head.failureID {
                            let (diagnostic, published) = try await recovery.diagnostic(failure)
                            if !published {
                                _ = try await pubsub.publish(topic: "cdc-dlq", data: diagnostic, key: "mysql84")
                                try await FaultGate.hit("after-dlq-publish", payload: head.delivery.payload)
                                try await recovery.markPublished(failure)
                            }
                            // Durable quarantine + confirmed publication must precede ACK.
                            if let delivery = current { try await pubsub.ack("cdc-consumer", ids: [delivery.ackID]) }
                            await lease?.stop(); lease = nil; current = nil
                            if reportedBlock != failure { log("BLOCKED", failure); reportedBlock = failure }
                            attempt = 0
                            try await Task.sleep(nanoseconds: 500_000_000)
                            continue // Do not pull later events while blocked, even after restart.
                        }
                        let applied: Bool
                        do {
                            guard head.delivery.orderingKey == "mysql84" else { throw POCError("Unexpected ordering key") }
                            applied = try await writer.apply(head.delivery.payload, afterMutation: {
                                try await FaultGate.hit("before-commit", payload: head.delivery.payload)
                            })
                        } catch {
                            guard TargetFailure.isPermanentEvent(error) else { throw error }
                            try await recovery.quarantine(head.delivery, reason: String(describing: error))
                            log("QUARANTINED", String(describing: error))
                            try await FaultGate.hit("after-quarantine", payload: head.delivery.payload)
                            continue
                        }
                        if applied { try await FaultGate.hit("after-commit", payload: head.delivery.payload) }
                        try await lease?.status.check()
                        if let delivery = current { try await pubsub.ack("cdc-consumer", ids: [delivery.ackID]) }
                        // On restart there may be no current ackID: apply is idempotent,
                        // and any later broker redelivery must go through that same ledger.
                        try await recovery.clear()
                        log(applied ? "APPLIED" : "DEDUPLICATED", try MaxwellEvent(data: head.delivery.payload).identity(source: sourceID))
                        await lease?.stop(); lease = nil; current = nil; attempt = 0
                    } else if let delivery = current {
                        if lease == nil { lease = try await Lease(pubsub: pubsub, delivery: delivery) }
                        try await recovery.retain(StoredDelivery(messageID: delivery.messageID, orderingKey: delivery.orderingKey, payload: delivery.data))
                    } else if let delivery = try await pubsub.pull("cdc-consumer", max: 1).first {
                        current = delivery
                        lease = try await Lease(pubsub: pubsub, delivery: delivery)
                    } else {
                        attempt = 0
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                } catch {
                    if PubSub.isMissingResource(error) {
                        throw POCError("Pub/Sub resource missing: possible emulator queue loss. Stop writers and rebuild/reseed a fresh project; do not recreate the queue and resume old checkpoints.")
                    }
                    guard TargetFailure.isTransient(error) || PubSub.isTransient(error) else { throw error }
                    if TargetFailure.isTransient(error) { await disconnect() }
                    log("RETRY", "attempt=\(attempt) error=\(error)")
                    try await Task.sleep(nanoseconds: RecoveryPolicy.delay(attempt: attempt)); attempt = min(attempt + 1, 10)
                }
            }
            await lease?.stop(); await disconnect()
        } catch { await lease?.stop(); await disconnect(); throw error }
    }

    /// Operator stops the consumer, fixes the cause, then retries the exact
    /// quarantined bytes. No skip/delete-head or replacement-payload escape hatch.
    public func repair() async throws {
        do {
            try await pubsub.checkSubscription("cdc-consumer")
            try await pubsub.checkSubscription("cdc-dlq-observer")
            try await connect()
            guard let head = try await store!.head(), let failure = head.failureID else { throw POCError("No blocked event to repair") }
            let (diagnostic, published) = try await store!.diagnostic(failure)
            if !published {
                _ = try await pubsub.publish(topic: "cdc-dlq", data: diagnostic, key: "mysql84")
                try await store!.markPublished(failure)
            }
            guard head.delivery.orderingKey == "mysql84" else { throw POCError("Stored ordering key is invalid; repair requires a reviewed code/policy correction") }
            try await applier!.apply(head.delivery.payload)
            try await store!.resolve(failure)
            log("REPAIRED", failure)
            await disconnect()
        } catch { await disconnect(); throw error }
    }
}
