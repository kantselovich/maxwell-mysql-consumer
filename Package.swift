// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "MaxwellMySQLConsumer",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "cdc-poc", targets: ["Consumer"])],
    dependencies: [
        .package(url: "https://github.com/vapor/mysql-nio.git", exact: "1.9.1"),
        .package(url: "https://github.com/grpc/grpc-swift.git", exact: "1.27.6"),
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.31.1"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.90.0"),
    ],
    targets: [
        .target(name: "ReplicationCore"),
        .target(name: "MySQLTarget", dependencies: [
            "ReplicationCore",
            .product(name: "MySQLNIO", package: "mysql-nio"),
            .product(name: "NIOPosix", package: "swift-nio"),
        ]),
        .target(name: "PubSubTransport", dependencies: [
            .product(name: "GRPC", package: "grpc-swift"),
            .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            .product(name: "NIOPosix", package: "swift-nio"),
        ], plugins: [.plugin(name: "SwiftProtobufPlugin", package: "swift-protobuf")]),
        .target(name: "E2EHarness", dependencies: ["ReplicationCore", "MySQLTarget", "PubSubTransport"]),
        .executableTarget(name: "Consumer", dependencies: ["E2EHarness", "ReplicationCore", "MySQLTarget", "PubSubTransport"]),
        .testTarget(name: "ReplicationCoreTests", dependencies: ["ReplicationCore"]),
    ],
    swiftLanguageModes: [.v5]
)
