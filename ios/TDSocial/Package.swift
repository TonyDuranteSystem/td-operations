// swift-tools-version:5.9
// TD Social iPhone app — the shared core (dev job 2072bc3e, Step 3). No UI here: pure logic (which tab opens which address, what an alert opens,
// what the server's answer means, the plain-language messages) that builds and tests WITHOUT code signing (`swift test`).
// The app (built by generate_xcodeproj.rb) compiles these same files into its own target.
import PackageDescription

let package = Package(
    name: "TDSocialCore",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "TDSocialCore", targets: ["TDSocialCore"])],
    targets: [
        .target(name: "TDSocialCore"),
        .testTarget(name: "TDSocialCoreTests", dependencies: ["TDSocialCore"]),
    ]
)
