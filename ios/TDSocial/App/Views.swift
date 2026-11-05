// The screens: sign-in, the tab bar, plain messages, the alerts question and the You screen. Wording comes from TDSocialCore/Strings.swift.
import SwiftUI
import Combine

private let brandRed = Color(red: 0.78, green: 0.06, blue: 0.18)

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    private let minute = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            switch model.screen {
            case .checking:
                VStack(spacing: 14) { ProgressView(); Text(AppConfig.say(.checking)).foregroundColor(.secondary) }
            case .signedOut:
                SignInView()
            case .ready:
                TabsView()
            case .noAccess:
                StatusView(title: AppConfig.say(.noAccessTitle), detail: AppConfig.say(.noAccessBody), primary: (AppConfig.say(.tryAgain), { Task { await model.check() } }), secondary: (AppConfig.say(.signOut), { Task { await model.signOut() } }))
            case .notSwitchedOn:
                StatusView(title: AppConfig.say(.notSwitchedOn), detail: nil, primary: (AppConfig.say(.tryAgain), { Task { await model.check() } }), secondary: nil)
            case .problem(let why):
                StatusView(title: AppConfig.say(.couldntLoad), detail: why, primary: (AppConfig.say(.tryAgain), { Task { await model.check() } }), secondary: nil)
            }
        }
        .task { await model.start() }
        .onChange(of: phase) { _, p in if p == .active { model.becameActive() } }
        .onReceive(minute) { _ in if phase == .active && model.screen == .ready { Task { await model.check() } } }
        .sheet(isPresented: $model.showAlertsSheet) { AlertsQuestionView() }
    }
}

struct StatusView: View {
    let title: String
    let detail: String?
    let primary: (String, () -> Void)
    let secondary: (String, () -> Void)?
    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            if let d = detail { Text(d).foregroundColor(.secondary).multilineTextAlignment(.center) }
            Button(primary.0, action: primary.1).buttonStyle(.borderedProminent).tint(brandRed)
            if let s = secondary { Button(s.0, action: s.1).foregroundColor(.secondary) }
        }
        .padding(32)
    }
}

struct SignInView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            Text(AppConfig.say(.signingIn)).font(.footnote).foregroundColor(.secondary).padding(.vertical, 8)
            ZStack { WebHostView(host: model.signInHost); FailedOverlay(host: model.signInHost) }
        }
        .id(ObjectIdentifier(model.signInHost))
    }
}

struct FailedOverlay: View {
    @ObservedObject var host: WebHost
    var body: some View {
        if host.failed {
            VStack(spacing: 14) {
                Text(AppConfig.say(.couldntLoad)).font(.headline)
                Button(AppConfig.say(.tryAgain)) { host.reload() }.buttonStyle(.borderedProminent).tint(brandRed)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.systemBackground))
        }
    }
}

private func symbol(for tabId: String) -> String {
    switch tabId {
    case "talk": return "bubble.left.and.bubble.right"
    case "portal": return "person.bubble"
    case "whatsapp": return "phone.bubble"
    case "inbox": return "envelope"
    case "marketing": return "at"
    default: return "square"
    }
}

struct TabsView: View {
    @EnvironmentObject var model: AppModel
    @State private var showYou = false
    var body: some View {
        if let me = model.me {
            VStack(spacing: 0) {
                // the "You" button lives in a thin strip, not in the tab bar: iPhone folds a sixth tab under "More"
                HStack {
                    Spacer()
                    Button { showYou = true } label: {
                        Text(Initials.of(name: me.user.name, email: me.user.email)).font(.footnote.weight(.semibold)).foregroundColor(.white)
                            .frame(width: 30, height: 30).background(Circle().fill(brandRed))
                    }
                    .accessibilityLabel(AppConfig.say(.youTitle))
                }
                .padding(.horizontal, 12).padding(.vertical, 4)
                TabView(selection: $model.selectedTab) {
                    ForEach(me.tabs) { tab in
                        TabPage(host: model.host(for: tab.id))
                            .tabItem { Label(TabPath.shortLabel(for: tab.id, fallback: tab.label), systemImage: symbol(for: tab.id)) }
                            .tag(tab.id)
                            .badge(me.count(for: tab.id))
                    }
                }
                .toolbar(me.tabs.count > 1 ? .visible : .hidden, for: .tabBar)   // a person with one tab (marketing) gets no tab bar
                .tint(brandRed)
            }
            .sheet(isPresented: $showYou) { YouView() }
            .onChange(of: model.selectedTab) { _, _ in model.tabChanged() }
        }
    }
}

struct TabPage: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var host: WebHost
    var body: some View {
        VStack(spacing: 0) {
            if model.offline { Text(AppConfig.say(.noConnectionBar)).font(.footnote).padding(8).frame(maxWidth: .infinity).background(Color.yellow.opacity(0.35)) }
            if !model.alertsAuthorized && !model.showAlertsSheet {
                Button { Task { await model.turnOnAlerts() } } label: {
                    Text(AppConfig.say(.alertsOffStrip) + " " + AppConfig.say(.alertsTurnOn)).font(.footnote).padding(8).frame(maxWidth: .infinity).background(Color.orange.opacity(0.25))
                }.buttonStyle(.plain)
            }
            ZStack { WebHostView(host: host); FailedOverlay(host: host) }
        }
    }
}

struct AlertsQuestionView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "bell.badge").font(.system(size: 44)).foregroundColor(brandRed)
            Text(AppConfig.say(.alertsTitle)).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            Text(AppConfig.say(.alertsBody)).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button(AppConfig.say(.alertsTurnOn)) { Task { await model.turnOnAlerts() } }.buttonStyle(.borderedProminent).tint(brandRed)
            Button(AppConfig.say(.alertsNotNow)) { model.skipAlerts() }.foregroundColor(.secondary)
        }
        .padding(32)
        .presentationDetents([.medium])
    }
}

struct YouView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var testSent: Bool?

    var body: some View {
        NavigationStack {
            List {
                if let me = model.me {
                    Section {
                        Text(me.user.name).font(.headline)
                        if let e = me.user.email { Text(e).foregroundColor(.secondary) }
                        Text(me.isMarketingOnly ? "Marketing team" : "TD team").foregroundColor(.secondary)
                    }
                    Section(header: Text("Alerts")) {
                        if !model.alertsAuthorized {
                            Button(AppConfig.say(.alertsTurnOn)) { Task { await model.turnOnAlerts() } }
                            Button(AppConfig.say(.alertsOpenSettings)) { model.openIPhoneSettings() }
                        }
                        if let on = me.prefs.whatsapp {
                            Toggle("WhatsApp", isOn: Binding(get: { on }, set: { v in Task { await model.setAlert("whatsapp", v) } }))
                        }
                        ForEach((me.prefs.email ?? [:]).keys.sorted(), id: \.self) { box in
                            Toggle("Email · \(box)@", isOn: Binding(get: { me.prefs.email?[box] ?? false }, set: { v in Task { await model.setAlert("email:\(box)", v) } }))
                        }
                        if !me.isMarketingOnly {
                            Button("Send me a test alert") { Task { testSent = await model.sendTestAlert() } }
                            if let ok = testSent { Text(ok ? "Sent. It should arrive in a few seconds." : "Could not send the test.").font(.footnote).foregroundColor(.secondary) }
                        }
                    }
                }
                Section {
                    Button(AppConfig.say(.signOut), role: .destructive) { Task { await model.signOut() } }
                }
                Section(header: Text("About")) {
                    LabeledContent("Version", value: "\(AppConfig.version) (\(AppConfig.build))")
                    LabeledContent("Server", value: AppConfig.serverName)
                }
            }
            .navigationTitle(AppConfig.say(.youTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}
