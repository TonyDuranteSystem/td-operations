// Small pure helpers for what the screens show.
import Foundation

public enum Initials {
    /// "Antonio Durante" -> "AD", "Luca" -> "L"; with no name the first letter of the email; with nothing "?"
    public static func of(name: String, email: String?) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }.map { String($0).uppercased() }.joined()
        if !letters.isEmpty { return letters }
        if let e = email?.trimmingCharacters(in: .whitespaces), let f = e.first { return String(f).uppercased() }
        return "?"
    }
}
