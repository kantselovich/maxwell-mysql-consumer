import Testing
import MySQLTarget
import MySQLNIO
import NIOCore
import ReplicationCore
import PubSubTransport
import GRPC

@Test func databaseOutageIncludesTemporaryDockerDNSLoss() {
    #expect(TargetFailure.isTransient(SocketAddressError.unknown(host: "mysql57", port: 3306)))
    #expect(TargetFailure.isTransient(MySQLError.closed))
    #expect(TargetFailure.isTransient(ChannelError.ioOnClosedChannel))
    #expect(!TargetFailure.isTransient(SocketAddressError.unsupported))
    #expect(!TargetFailure.isPermanentEvent(SocketAddressError.unknown(host: "mysql57", port: 3306)))
}

@Test func eventFailuresAreNotRetriedAsConnectivityFailures() {
    #expect(TargetFailure.isPermanentEvent(POCError("Unsupported DDL")))
    #expect(TargetFailure.isPermanentEvent(MySQLError.duplicateEntry("duplicate key")))
    #expect(TargetFailure.isPermanentEvent(MySQLError.invalidSyntax("syntax")))
    #expect(!TargetFailure.isTransient(MySQLError.duplicateEntry("duplicate key")))
    #expect(!TargetFailure.isPermanentEvent(MySQLError.unsupportedAuthPlugin(name: "unknown")))
}

@Test func transportTimeoutsAndResourceLossAreDistinct() {
    #expect(PubSub.isTransient(GRPCError.RPCTimedOut(.timeout(.seconds(5)))))
    #expect(PubSub.isTransient(GRPCStatus(code: .unavailable)))
    #expect(!PubSub.isTransient(GRPCStatus(code: .notFound)))
    #expect(PubSub.isMissingResource(GRPCStatus(code: .notFound)))
    #expect(!PubSub.isMissingResource(GRPCError.RPCTimedOut(.timeout(.seconds(5)))))
    #expect(!PubSub.isTransient(GRPCStatus(code: .permissionDenied)))
}
