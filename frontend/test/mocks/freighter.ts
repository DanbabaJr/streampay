export const freighterMockState = {
  connected: false,
  address: null as string | null,
  error: null as { message?: string } | null,
  signedMessage: null as string | Uint8Array | null,
  signError: null as { message?: string } | null,
  networkPassphrase: "Test SDF Network ; September 2015",
};

export function setMockFreighter(s: Partial<typeof freighterMockState>) {
  Object.assign(freighterMockState, s);
}

export function resetMockFreighter() {
  freighterMockState.connected = false;
  freighterMockState.address = null;
  freighterMockState.error = null;
  freighterMockState.signedMessage = null;
  freighterMockState.signError = null;
  freighterMockState.networkPassphrase = "Test SDF Network ; September 2015";
}

export async function isConnected() {
  return { isConnected: freighterMockState.connected };
}

export async function requestAccess() {
  return { address: freighterMockState.address, error: freighterMockState.error };
}

export async function signMessage() {
  return { signedMessage: freighterMockState.signedMessage, error: freighterMockState.signError };
}

export async function getNetwork() {
  return { networkPassphrase: freighterMockState.networkPassphrase };
}
