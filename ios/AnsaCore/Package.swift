// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AnsaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AnsaCore", targets: ["AnsaCore"]),
        .library(name: "AnsaSync", targets: ["AnsaSync"]),
    ],
    targets: [
        .target(name: "AnsaCore"),
        // Separate from AnsaCore so the tree model stays pure: AnsaCore has no
        // URLSession, no clock and no disk, which is what lets its suite run
        // the real ops with nothing stubbed.
        .target(name: "AnsaSync", dependencies: ["AnsaCore"]),
        .testTarget(
            name: "AnsaCoreTests",
            dependencies: ["AnsaCore"],
            resources: [.process("Fixtures")]
        ),
        .testTarget(name: "AnsaSyncTests", dependencies: ["AnsaSync"]),
    ]
)
