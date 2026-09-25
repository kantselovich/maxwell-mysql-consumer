import Foundation
import GRPC
import NIOPosix
import SwiftProtobuf

public struct Delivery {
    public let ackID: String
    public let messageID: String
    public let data: Data
    public let orderingKey: String
}

/// Plaintext, credential-free emulator transport only. Not a production GCP client.
public final class PubSub {
    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private let channel: ClientConnection
    private let project: String

    public init(host: String, port: Int = 8085, project: String = "local-cdc") {
        self.project = project
        channel = ClientConnection.insecure(group: group).connect(host: host, port: port)
    }

    private func rpc<Q: SwiftProtobuf.Message, R: SwiftProtobuf.Message>(
        _ service: String, _ method: String, _ request: Q, as: R.Type = R.self
    ) async throws -> R {
        let call: UnaryCall<Q, R> = channel.makeUnaryCall(
            path: "/google.pubsub.v1.\(service)/\(method)", request: request,
            callOptions: CallOptions(timeLimit: .timeout(.seconds(5))), interceptors: []
        )
        return try await call.response.get()
    }

    private func topic(_ name: String) -> String { "projects/\(project)/topics/\(name)" }
    private func subscription(_ name: String) -> String { "projects/\(project)/subscriptions/\(name)" }

    public func createTopic(_ name: String) async throws {
        var request = Google_Pubsub_V1_Topic(); request.name = topic(name)
        do { let _: Google_Pubsub_V1_Topic = try await rpc("Publisher", "CreateTopic", request) }
        catch let error as GRPCStatus where error.code == .alreadyExists {}
    }

    public func createSubscription(_ name: String, topic topicName: String) async throws {
        var request = Google_Pubsub_V1_Subscription()
        request.name = subscription(name); request.topic = topic(topicName)
        request.ackDeadlineSeconds = 10; request.enableMessageOrdering = true
        do { let _: Google_Pubsub_V1_Subscription = try await rpc("Subscriber", "CreateSubscription", request) }
        catch let error as GRPCStatus where error.code == .alreadyExists {}
        var get = Google_Pubsub_V1_GetSubscriptionRequest(); get.subscription = subscription(name)
        let actual: Google_Pubsub_V1_Subscription = try await rpc("Subscriber", "GetSubscription", get)
        guard actual.topic == request.topic, actual.enableMessageOrdering else {
            throw NSError(domain: "SubscriptionConfigurationMismatch", code: 1)
        }
    }

    public func checkSubscription(_ name: String) async throws {
        var request = Google_Pubsub_V1_GetSubscriptionRequest(); request.subscription = subscription(name)
        let _: Google_Pubsub_V1_Subscription = try await rpc("Subscriber", "GetSubscription", request)
    }

    public func deleteSubscription(_ name: String) async throws {
        var request = Google_Pubsub_V1_DeleteSubscriptionRequest(); request.subscription = subscription(name)
        let _: Google_Pubsub_V1_Empty = try await rpc("Subscriber", "DeleteSubscription", request)
    }

    @discardableResult
    public func publish(topic name: String, data: Data, key: String) async throws -> String {
        var message = Google_Pubsub_V1_PubsubMessage(); message.data = data; message.orderingKey = key
        var request = Google_Pubsub_V1_PublishRequest(); request.topic = topic(name); request.messages = [message]
        let response: Google_Pubsub_V1_PublishResponse = try await rpc("Publisher", "Publish", request)
        return response.messageIds[0]
    }

    public func pull(_ name: String, max: Int32 = 100) async throws -> [Delivery] {
        var request = Google_Pubsub_V1_PullRequest()
        request.subscription = subscription(name); request.maxMessages = max
        request.returnImmediately = true // Bounded diagnostic polling on the emulator.
        let response: Google_Pubsub_V1_PullResponse = try await rpc("Subscriber", "Pull", request)
        return response.receivedMessages.map {
            Delivery(ackID: $0.ackID, messageID: $0.message.messageID,
                     data: $0.message.data, orderingKey: $0.message.orderingKey)
        }
    }

    public func ack(_ name: String, ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        var request = Google_Pubsub_V1_AcknowledgeRequest()
        request.subscription = subscription(name); request.ackIds = ids
        let _: Google_Pubsub_V1_Empty = try await rpc("Subscriber", "Acknowledge", request)
    }

    public func deadline(_ name: String, ids: [String], seconds: Int32) async throws {
        var request = Google_Pubsub_V1_ModifyAckDeadlineRequest()
        request.subscription = subscription(name); request.ackIds = ids; request.ackDeadlineSeconds = seconds
        let _: Google_Pubsub_V1_Empty = try await rpc("Subscriber", "ModifyAckDeadline", request)
    }

    public func close() async {
        try? await channel.close().get()
        try? await group.shutdownGracefully()
    }
}
