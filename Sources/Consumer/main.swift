import Foundation
import E2EHarness
import MySQLTarget
import PubSubTransport
import ReplicationCore
import ConsumerRuntime

@main
enum Main {
    static func main() async {
        let settings = Settings()
        let command = CommandLine.arguments.dropFirst().first ?? "observe"
        if command == "replay-position" {
            do { print(try PhaseOne.loadCapture(settings).startPosition) }
            catch { fail(error) }
            return
        }
        let pubsub = PubSub(host: settings.pubsubHost)
        do {
            switch command {
            case "init": try await PhaseOne.initialize(pubsub)
            case "probe": try await PhaseOne.capture(pubsub, settings: settings)
            case "verify-replay": try await PhaseOne.verifyReplay(pubsub, settings: settings)
            case "phase2": try await PhaseTwo.run(pubsub, settings: settings)
            case "phase4": try await PhaseFour(pubsub: pubsub, settings: settings).run(CommandLine.arguments.dropFirst(2).first ?? "verify")
            case "e2e": try await ScenarioHarness.run(pubsub, settings: settings)
            case "harness-check-negative": try ScenarioHarness.checkNegativeResult(settings: settings)
            case "recovery-tests": try await PhaseTwo.recovery(settings: settings)
            case "health":
                try await pubsub.checkSubscription("cdc-consumer")
                if ProcessInfo.processInfo.environment["CONSUMER_MODE"] != "observe" {
                    let db = Database()
                    do {
                        try await PhaseOne.connect(db, host: settings.targetHost)
                        let lock = try await db.query("SELECT IS_USED_LOCK('cdc-applier-poc') AS owner")
                        try PhaseOne.require(lock.first?["owner"] != nil, "Applier is not ready")
                        let blocked = try await db.query("SELECT failure_id FROM cdc_meta.consumer_head WHERE failure_id IS NOT NULL")
                        try PhaseOne.require(blocked.isEmpty, "Stream blocked by durable quarantine; operator repair required")
                        await db.close()
                    } catch { await db.close(); throw error }
                }
            case "apply":
                try await ConsumerLoop(pubsub: pubsub, targetHost: settings.targetHost, sourceID: settings.sourceID).run()
            case "repair":
                try await ConsumerLoop(pubsub: pubsub, targetHost: settings.targetHost, sourceID: settings.sourceID).repair()
            case "observe":
                print("Phase 1 diagnostic observer: no target writes; cdc-consumer remains untouched")
                while !Task.isCancelled {
                    let batch = try await pubsub.pull("cdc-diagnostic")
                    for delivery in batch {
                        let event = try MaxwellEvent(data: delivery.data)
                        print("observed \(try event.identity(source: settings.sourceID)) \(String(decoding: delivery.data, as: UTF8.self))")
                    }
                    try await pubsub.ack("cdc-diagnostic", ids: batch.map(\.ackID))
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
            default: throw POCError("Unknown command: \(command)")
            }
            await pubsub.close()
        } catch {
            await pubsub.close()
            fail(error)
        }
    }

    private static func fail(_ error: Error) -> Never {
        FileHandle.standardError.write(Data("ERROR: \(error)\n".utf8))
        exit(1)
    }
}
