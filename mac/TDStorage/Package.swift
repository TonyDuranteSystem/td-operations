// swift-tools-version:5.9
// TD Storage Mac app — the shared core (dev job 1992a087). No UI, no File Provider here: pure logic that builds and tests
// WITHOUT code signing (`swift test`). The host app and the Finder extension (built by generate_xcodeproj.rb) link this.
import PackageDescription

let package = Package(
    name: "TDStorageCore",
    platforms: [.macOS(.v13)],
    products: [.library(name: "TDStorageCore", targets: ["TDStorageCore"])],
    targets: [
        .target(name: "TDStorageCore"),
        .testTarget(name: "TDStorageCoreTests", dependencies: ["TDStorageCore"]),
    ]
)
