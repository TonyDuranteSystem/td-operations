import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: ClientModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            WebHost()
                .id(model.webEpoch)   // a sign-out makes a brand-new web view (no page of the person who left stays in its history)
                .ignoresSafeArea(edges: .bottom)
                .overlay { if model.loadFailed { LoadFailedView() } }
            if let me = model.me { BottomBar(me: me) }
        }
        // coming back to the app: the numbers on the bar and the alerts setting may have changed meanwhile
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshMe() } }
        }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .menu: MenuSheet()
            case .alerts: AlertsAskSheet()
            }
        }
    }
}

/// The page could not be loaded (no connection ...): a plain message and a button, instead of a blank screen.
struct LoadFailedView: View {
    @EnvironmentObject var model: ClientModel
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.slash").font(.system(size: 34)).foregroundColor(.secondary)
            Text(AppConfig.say(.couldntLoad)).font(.headline)
            Text(AppConfig.say(.noConnection)).font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button(AppConfig.say(.tryAgain)) { model.retry() }
                .buttonStyle(.borderedProminent).accessibilityIdentifier("retry")
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

private func symbol(_ key: String) -> String {
    switch key {
    case "nav.overview": return "house"
    case "nav.chat": return "bubble.left"
    case "nav.documents": return "folder"
    case "nav.invoices": return "doc.text"
    case "nav.tdBilling": return "creditcard"
    case "nav.signDocuments": return "signature"
    default: return "circle"
    }
}

struct BottomBar: View {
    @EnvironmentObject var model: ClientModel
    let me: Me

    var body: some View {
        HStack(spacing: 0) {
            ForEach(me.bar, id: \.self) { key in
                if let item = me.items.first(where: { $0.key == key }) {
                    let active = BarRules.isActive(itemPath: item.path, currentPath: model.currentPath, currentTab: model.currentTab)
                    Button { model.open(path: item.path) } label: {
                        VStack(spacing: 2) {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: symbol(key)).font(.system(size: 22))
                                if item.badge > 0 {
                                    Text("\(item.badge)").font(.system(size: 10, weight: .bold)).foregroundColor(.white)
                                        .padding(.horizontal, 5).background(Color.red).clipShape(Capsule()).offset(x: 10, y: -6)
                                }
                            }
                            Text(item.label).font(.system(size: 10, weight: active ? .bold : .regular)).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity).foregroundColor(active ? .primary : .secondary)
                    }
                    .accessibilityIdentifier("bar-\(key)")
                }
            }
        }
        .padding(.top, 8).padding(.bottom, 4)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

struct MenuSheet: View {
    @EnvironmentObject var model: ClientModel

    var body: some View {
        NavigationStack {
            List {
                if let me = model.me {
                    Section {
                        ForEach(me.items) { item in
                            Button { model.open(path: item.path) } label: {
                                HStack {
                                    Text(item.label)
                                    Spacer()
                                    if item.badge > 0 {
                                        Text("\(item.badge)").font(.caption.bold()).foregroundColor(.white).padding(.horizontal, 7).padding(.vertical, 2).background(Color.red).clipShape(Capsule())
                                    }
                                }
                            }
                            .foregroundColor(.primary)
                            .accessibilityIdentifier("menu-\(item.key)")
                        }
                    }
                    if model.alertsOff || model.alertsPending {
                        Section {
                            Text(AppConfig.say(.alertsOffStrip)).font(.footnote).foregroundColor(.secondary)
                            if model.alertsOff {
                                Button(AppConfig.say(.alertsOpenSettings)) { model.openPhoneSettings() }.accessibilityIdentifier("open-settings")
                            } else {
                                // "Not now" was chosen and iPhone was never asked: asking again is one tap here
                                Button(AppConfig.say(.alertsTurnOn)) { Task { await model.turnOnAlerts() } }.accessibilityIdentifier("menu-turn-on-alerts")
                            }
                        }
                    }
                } else {
                    Section {
                        Text(model.meOutcome == nil || model.meOutcome == .signedOut ? AppConfig.say(.signInFirst) : AppConfig.say(.menuUnavailable))
                    }
                }
                // Sign out is always there while somebody is signed in, also when the server cannot answer (the app switched off, a fault)
                if model.meOutcome != .signedOut {
                    Section {
                        Button(AppConfig.say(.signOut), role: .destructive) { Task { await model.signOut() } }.accessibilityIdentifier("sign-out")
                    }
                }
                #if DEBUG
                Section { Text(model.status).font(.footnote).foregroundColor(.secondary).accessibilityIdentifier("alert-status") }
                #endif
            }
            .navigationTitle(AppConfig.say(.menuTitle))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(AppConfig.say(.close)) { model.sheet = nil } } }
            // the server could not be told to forget this phone (no connection ...): the person is still signed in and is told so
            .alert(AppConfig.say(.signOutFailed), isPresented: $model.signOutFailed) { Button(AppConfig.say(.ok), role: .cancel) {} }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The one question about alerts, asked once after the first sign-in.
struct AlertsAskSheet: View {
    @EnvironmentObject var model: ClientModel

    var body: some View {
        // scrolls, and can be pulled up to full height: with large text or a small iPhone the buttons must never be cut off
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "bell.badge").font(.system(size: 40)).foregroundColor(.accentColor).padding(.top, 28)
                Text(AppConfig.say(.alertsTitle)).font(.title3.bold()).multilineTextAlignment(.center)
                Text(AppConfig.say(.alertsBody)).font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                Button { Task { await model.turnOnAlerts() } } label: { Text(AppConfig.say(.alertsTurnOn)).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("alerts-turn-on")
                Button(AppConfig.say(.alertsNotNow)) { model.notNow() }.accessibilityIdentifier("alerts-not-now")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled()
    }
}
