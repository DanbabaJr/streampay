import Foundation

/** Compile smoke: the generated UniFFI surface and its scalar mappings. */
func streamPaySmoke(_ client: StreamPayMobile) throws {
    let stream = try client.getStream(streamId: 1)
    let id: UInt64 = stream.id
    let status = stream.status
    let oracle: Bool? = stream.useOracle
    let available: String = try client.available(streamId: 1)
    let recipientIds: [UInt64] = try client.recipientStreams(
        recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        offset: 0,
        limit: 50
    )
    let senderIds: [UInt64] = try client.senderStreams(
        sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        offset: 0,
        limit: 50
    )
}
