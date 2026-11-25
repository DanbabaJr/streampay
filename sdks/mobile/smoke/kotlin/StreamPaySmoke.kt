import uniffi.streampay.StreamPayMobile

/** Compile smoke: the generated UniFFI surface and its scalar mappings. */
@Suppress("UNUSED_VARIABLE")
fun streamPaySmoke(client: StreamPayMobile) {
    val stream = client.getStream(1uL)
    val id: ULong = stream.id
    val status = stream.status
    val oracle: Boolean? = stream.useOracle
    val available: String = client.available(1uL)
    val recipientIds: List<ULong> = client.recipientStreams(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        0u,
        50u,
    )
    val senderIds: List<ULong> = client.senderStreams(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        0u,
        50u,
    )
}
