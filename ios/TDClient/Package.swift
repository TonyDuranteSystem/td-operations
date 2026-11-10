// swift-tools-version:5.9
// MyLLC Manager 2.0 (the client iPhone app) — the shared core (dev job 056a70d0, Step 5). No UI here: pure logic (which links stay in the app,
// what counts as a file, which alert links are safe, the plain-language messages in English and Italian) that builds and tests WITHOUT code
// signing (`swift test`). The app (built by generate_xcodeproj.rb) compiles these same files into its own target.
import PackageDescription

let package = Package(
    name: "TDClientCore",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "TDClientCore", targets: ["TDClientCore"])],
    targets: [
        .target(name: "TDClientCore"),
        .testTarget(name: "TDClientCoreTests", dependencies: ["TDClientCore"]),
    ]
)
