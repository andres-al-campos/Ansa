// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AnsaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AnsaCore", targets: ["AnsaCore"])
    ],
    targets: [
        .target(name: "AnsaCore"),
        .testTarget(
            name: "AnsaCoreTests",
            dependencies: ["AnsaCore"],
            resources: [.process("Fixtures")]
        ),
    ]
)
