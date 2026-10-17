import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("TD Storage").font(.title.bold())
            Text("The company storage as a folder in Finder.").foregroundStyle(.secondary)
            Divider()
            switch model.state {
            case .checking:
                ProgressView("Checking…")
            case .signedOut:
                Text("Sign in with your CRM login. A page opens in your browser; approve this Mac there.")
                Button("Sign in…") { Task { await model.signIn() } }.keyboardShortcut(.defaultAction)
            case .waiting(let code):
                Text("Approve this Mac in the browser page that just opened.")
                Text("Check code").font(.caption).foregroundStyle(.secondary)
                Text(code).font(.system(size: 28, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                Text("The page shows the same code. If it is different, close the page and do not approve.").font(.callout).foregroundStyle(.secondary)
            case .signedIn(let who):
                Label("Signed in as \(who)", systemImage: "checkmark.seal")
                Text("TD Storage is in the Finder sidebar.").foregroundStyle(.secondary)
                HStack {
                    Button("Open in Finder") { model.openInFinder() }
                    Button("Sign out") { Task { await model.signOut() } }
                }
            case .problem(let message):
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Button("Try again") { Task { await model.start() } }
            }
            Spacer(minLength: 0)
            Text("Server: \(model.serverLabel) · This Mac: \(model.deviceName)").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(24)
    }
}
