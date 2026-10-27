import Foundation

/// The JSON the CRM answers (shapes verified against the sandbox by scripts/crm-store/qa-cutover/t33-storage-app-signin.ts).
public struct TokenPair: Codable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresIn: Int
    public var deviceId: String
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", deviceId = "device_id" }
    public init(accessToken: String, refreshToken: String, expiresIn: Int, deviceId: String) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresIn = expiresIn; self.deviceId = deviceId
    }
}

public struct WhoAmI: Codable, Equatable {
    public var userId: String; public var email: String?; public var role: String?; public var owner: Bool; public var deviceId: String
    /// `latestBuild`: the newest app build the CRM offers THIS Mac (nil = none) — the app checks for the update at once when it is newer than its own.
    /// the values the CRM's settings row gives the Mac (older servers do not send them)
    public var leaseHours: Double?; public var resyncMinutes: Double?; public var updateCheckMinutes: Double?; public var latestBuild: Int?; public var updateHintSeconds: Double?
}

public struct NavOwner: Codable, Equatable, Hashable {
    public var id: String; public var kind: String; public var label: String; public var status: String?; public var fileCount: Int
}
public struct NavGroup: Codable, Equatable {
    public var key: String; public var label: String; public var section: String; public var owners: [NavOwner]
}
public struct NavigationResponse: Codable, Equatable { public var groups: [NavGroup] }

public struct FolderRef: Codable, Equatable, Hashable { public var id: String; public var name: String; public var kind: String; public var locked: Bool; public var canSave: Bool? }
public struct FileRef: Codable, Equatable, Hashable {
    public var id: String; public var name: String; public var size: Int?; public var mimeType: String?; public var updatedAt: String; public var downloadable: Bool
    /// true when THIS Mac saved the file: only such files can be updated from this Mac (as a new version)
    public var mine: Bool?
}
public struct OwnerInfo: Codable, Equatable { public var kind: String; public var label: String; public var accountStatus: String?; public var closed: Bool }
/// a person listed in a company's "2. Contacts": `ownerId` is that person's own storage (nil = none to open)
public struct PersonRef: Codable, Equatable, Hashable { public var contactId: String; public var name: String; public var ownerId: String? }
public struct FolderListing: Codable, Equatable {
    public var owner: OwnerInfo; public var folder: FolderRef?; public var folders: [FolderRef]; public var files: [FileRef]
    public var people: [PersonRef]?
}

public enum ChangeKind: String, Codable { case file, folder, owner }
public enum ChangeOp: String, Codable { case upsert, delete }
public struct AppChange: Codable, Equatable {
    public var kind: ChangeKind; public var id: String; public var op: ChangeOp
    public var ownerId: String?; public var parentId: String?; public var oldOwnerId: String?; public var oldParentId: String?; public var name: String?
}
public struct ChangesPage: Codable, Equatable { public var changes: [AppChange]; public var cursor: String?; public var resync: Bool; public var hasMore: Bool; public var resyncMinutes: Double? }
public struct HeadResponse: Codable, Equatable { public var cursor: String? }
public struct APIErrorBody: Codable { public var error: String?; public var errorDescription: String?; public var message: String?
    enum CodingKeys: String, CodingKey { case error, errorDescription = "error_description", message } }

/// One file or folder by id with its parent (GET /api/storage-app/item). `parentId` nil = a storage's top folder.
public struct ItemInfo: Codable, Equatable {
    public var kind: String; public var id: String; public var ownerId: String; public var parentId: String?; public var name: String
    public var locked: Bool?; public var canSave: Bool?; public var mine: Bool?; public var size: Int?; public var mimeType: String?; public var updatedAt: String?; public var downloadable: Bool?
}

/// POST /api/storage-app/upload-slot — where to put the bytes (or: this very file was already saved).
public struct UploadSlot: Codable, Equatable {
    public var intentId: String?; public var uploadUrl: String?; public var maxBytes: Int?
    public var alreadySaved: Bool?; public var fileId: String?; public var ownerId: String?; public var name: String?
}
/// POST /api/storage-app/save — the file as the CRM stored it (the name may differ if the CRM had to change it).
public struct SavedFile: Codable, Equatable { public var fileId: String; public var ownerId: String; public var name: String; public var size: Int? }

/// GET /api/storage-app/file — a 60-second signed link for one file, with what the app must check on arrival.
public struct FileDownload: Codable, Equatable {
    public var url: String; public var name: String; public var size: Int?; public var mimeType: String?; public var sha256: String?; public var expiresIn: Int
    /// Set by the CRM: the copy a Mac keeps of this file must be removed after `keepSeconds` (120 for sensitive papers, 900 for the rest). Nil from an older server.
    public var sensitive: Bool?; public var keepSeconds: Int?
}
