import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: ClientModel

    var body: some View {
        VStack(spacing: 0) {
            WebHost().ignoresSafeArea(edges: .bottom)
            if let me = model.me { BottomBar(me: me) }
        }
        .sheet(isPresented: $model.showMenu) { MenuSheet() }
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
                    let path = item.path.split(separator: "?").first.map(String.init) ?? item.path
                    let active = path == "/portal" ? model.currentPath == "/portal" : model.currentPath.hasPrefix(path)
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
                    ForEach(me.items) { item in
                        Button { model.open(path: item.path) } label: {
                            HStack { Text(item.label); Spacer(); if item.badge > 0 { Text("\(item.badge)").font(.caption.bold()).foregroundColor(.white).padding(.horizontal, 7).padding(.vertical, 2).background(Color.red).clipShape(Capsule()) } }
                        }.foregroundColor(.primary)
                    }
                } else {
                    Text("Sign in on the portal page first.")
                }
                Section { Text(model.alertStatus).font(.footnote).foregroundColor(.secondary).accessibilityIdentifier("alert-status") }
            }
            .navigationTitle("Menu")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { model.showMenu = false } } }
        }
        .presentationDetents([.medium, .large])
    }
}
