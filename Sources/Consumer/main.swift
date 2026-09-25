import Foundation
import E2EHarness
import MySQLTarget
import PubSubTransport
import ReplicationCore

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
            case "health": try await pubsub.checkSubscription("cdc-diagnostic")
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
