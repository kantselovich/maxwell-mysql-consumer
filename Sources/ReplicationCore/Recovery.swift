import Foundation

/// Raw bytes survive even when Maxwell JSON/identity cannot be decoded.
public struct StoredDelivery: Codable, Equatable {
    public let messageID: String
    public let orderingKey: String
    public let payload: Data
    public init(messageID: String, orderingKey: String, payload: Data) {
        self.messageID = messageID; self.orderingKey = orderingKey; self.payload = payload
    }
}

public struct QuarantineDiagnostic: Codable, Equatable {
    public let failureID: String
    public let sourceID: String
    public let eventID: String?
    public let delivery: StoredDelivery
    public let reason: String
    public init(sourceID: String, delivery: StoredDelivery, reason: String) {
        failureID = UUID().uuidString.lowercased()
        self.sourceID = sourceID; self.delivery = delivery; self.reason = reason
        eventID = try? MaxwellEvent(data: delivery.payload).identity(source: sourceID)
    }
}

public enum RecoveryPolicy {
    /// Capped exponential delay; never advance or quarantine merely due to age.
    public static func delay(attempt: Int) -> UInt64 {
        min(5_000_000_000, 250_000_000 * UInt64(1 << min(5, max(0, attempt))))
    }
}
