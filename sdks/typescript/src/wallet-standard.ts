import type { Signer } from "./client.js";

export type WalletFeature = "signTransaction" | "signAndSubmit";

/** Capabilities are explicit: network values are Stellar network passphrases. */
export interface WalletCapabilities {
  readonly features: readonly WalletFeature[];
  readonly networks: readonly string[] | "*";
}

export interface WalletDescriptor {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly capabilities: WalletCapabilities;
}

export interface WalletAccount {
  readonly publicKey: string;
  readonly address: string;
}

export interface WalletConnectOptions {
  readonly networkPassphrase: string;
}

export interface WalletTransactionOptions {
  readonly networkPassphrase: string;
  readonly address?: string;
}

export interface WalletSignAndSubmitResult {
  readonly hash: string;
  readonly signedTxXdr?: string;
}

/**
 * Common SDK-facing contract for wallet adapters. Implementations must forward
 * signing requests to the wallet; private keys must never be exposed to the SDK.
 */
export interface WalletStandardAdapter {
  readonly id: string;
  readonly name: string;
  discover(): Promise<readonly WalletDescriptor[]>;
  connect(walletId: string, options: WalletConnectOptions): Promise<WalletAccount>;
  signTransaction(
    envelopeXdr: string,
    options: WalletTransactionOptions
  ): Promise<{ signedTxXdr: string }>;
  signAndSubmit(
    envelopeXdr: string,
    options: WalletTransactionOptions
  ): Promise<WalletSignAndSubmitResult>;
  disconnect(): Promise<void>;
}

export interface WalletSelection {
  readonly networkPassphrase: string;
  readonly requireSignAndSubmit?: boolean;
}

export interface SelectedWallet {
  readonly adapter: WalletStandardAdapter;
  readonly wallet: WalletDescriptor;
}

export class WalletCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletCapabilityError";
  }
}

/**
 * Registry for wallet adapters. Discovery is intentionally injected so this
 * package works in browsers, SSR, and non-React applications without touching
 * global state or depending on a particular wallet package.
 */
export class WalletRegistry {
  constructor(private readonly adapters: readonly WalletStandardAdapter[]) {}

  async discover(selection?: WalletSelection): Promise<SelectedWallet[]> {
    const discovered = await Promise.all(
      this.adapters.map(async (adapter) => ({
        adapter,
        wallets: await adapter.discover(),
      }))
    );
    return discovered.flatMap(({ adapter, wallets }) =>
      wallets
        .filter((wallet) => !selection || supports(wallet.capabilities, selection))
        .map((wallet) => ({ adapter, wallet }))
    );
  }

  async select(selection: WalletSelection, walletId?: string): Promise<SelectedWallet> {
    const available = await this.discover(selection);
    const selected = walletId === undefined
      ? available[0]
      : available.find(({ wallet, adapter }) => wallet.id === walletId || adapter.id === walletId);
    if (selected) return selected;

    const installed = await this.discover();
    if (installed.length === 0) {
      throw new WalletCapabilityError("No compliant Stellar wallet was detected.");
    }
    const required = selection.requireSignAndSubmit ? "sign-and-submit" : "transaction signing";
    throw new WalletCapabilityError(
      `No installed Stellar wallet supports ${required} on the requested network.`
    );
  }

  /** Connect a selected wallet and expose it using the SDK's existing Signer API. */
  async connectSigner(
    selection: WalletSelection,
    walletId?: string
  ): Promise<{ selected: SelectedWallet; account: WalletAccount; signer: Signer }> {
    const selected = await this.select(selection, walletId);
    const account = await selected.adapter.connect(selected.wallet.id, {
      networkPassphrase: selection.networkPassphrase,
    });
    const signer: Signer = {
      publicKey: () => account.publicKey,
      signTransaction: (envelopeXdr, options) =>
        selected.adapter.signTransaction(envelopeXdr, options),
    };
    return { selected, account, signer };
  }
}

function supports(capabilities: WalletCapabilities, selection: WalletSelection): boolean {
  const feature: WalletFeature = selection.requireSignAndSubmit ? "signAndSubmit" : "signTransaction";
  return capabilities.features.includes(feature) &&
    (capabilities.networks === "*" || capabilities.networks.includes(selection.networkPassphrase));
}

/** Minimal shape of the Wallet Standard registry and Stellar wallet features. */
export interface WalletStandardRegistrySource {
  get(): readonly StandardStellarWallet[];
  on?(event: "register", listener: (wallet: StandardStellarWallet) => void): void | (() => void);
}

export interface StandardStellarWallet {
  readonly name: string;
  readonly icon?: string;
  readonly features: {
    readonly "stellar:connect"?: {
      connect(options: WalletConnectOptions): Promise<WalletAccount>;
    };
    readonly "stellar:signTransaction"?: {
      signTransaction(input: {
        envelopeXdr: string;
        networkPassphrase: string;
        address?: string;
      }): Promise<{ signedTxXdr: string }>;
    };
    readonly "stellar:signAndSubmit"?: {
      signAndSubmit(input: {
        envelopeXdr: string;
        networkPassphrase: string;
        address?: string;
      }): Promise<WalletSignAndSubmitResult>;
    };
    readonly "stellar:disconnect"?: { disconnect(): Promise<void> };
    readonly "stellar:capabilities"?: { capabilities: WalletCapabilities };
  };
}

/** Bridges wallets registered with a Wallet Standard-compatible registry. */
export class StandardWalletAdapter implements WalletStandardAdapter {
  readonly id = "stellar-wallet-standard";
  readonly name = "Stellar Wallet Standard";
  private readonly wallets = new Map<string, StandardStellarWallet>();
  private activeWallet: StandardStellarWallet | undefined;
  private activeAccount: WalletAccount | undefined;

  constructor(private readonly source: WalletStandardRegistrySource) {
    source.on?.("register", (wallet) => this.remember(wallet));
  }

  async discover(): Promise<readonly WalletDescriptor[]> {
    for (const wallet of this.source.get()) this.remember(wallet);
    return [...this.wallets.entries()].flatMap(([id, wallet]) => {
      const capabilities = wallet.features["stellar:capabilities"]?.capabilities ?? {
        features: [
          ...(wallet.features["stellar:signTransaction"] ? ["signTransaction" as const] : []),
          ...(wallet.features["stellar:signAndSubmit"] ? ["signAndSubmit" as const] : []),
        ],
        networks: "*" as const,
      };
      if (capabilities.features.length === 0) return [];
      return [{ id, name: wallet.name, ...(wallet.icon ? { icon: wallet.icon } : {}), capabilities }];
    });
  }

  async connect(walletId: string, options: WalletConnectOptions): Promise<WalletAccount> {
    const wallet = this.requireWallet(walletId);
    const connect = wallet.features["stellar:connect"];
    if (!connect) throw new WalletCapabilityError(`${wallet.name} does not expose stellar:connect.`);
    this.activeAccount = await connect.connect(options);
    this.activeWallet = wallet;
    return this.activeAccount;
  }

  async signTransaction(envelopeXdr: string, options: WalletTransactionOptions) {
    const wallet = this.requireActiveWallet();
    const feature = wallet.features["stellar:signTransaction"];
    if (!feature) throw new WalletCapabilityError(`${wallet.name} supports no signTransaction feature.`);
    return feature.signTransaction({
      envelopeXdr,
      networkPassphrase: options.networkPassphrase,
      ...(options.address ?? this.activeAccount?.address
        ? { address: options.address ?? this.activeAccount?.address }
        : {}),
    });
  }

  async signAndSubmit(envelopeXdr: string, options: WalletTransactionOptions) {
    const wallet = this.requireActiveWallet();
    const feature = wallet.features["stellar:signAndSubmit"];
    if (!feature) throw new WalletCapabilityError(`${wallet.name} does not support sign-and-submit.`);
    return feature.signAndSubmit({
      envelopeXdr,
      networkPassphrase: options.networkPassphrase,
      ...(options.address ?? this.activeAccount?.address
        ? { address: options.address ?? this.activeAccount?.address }
        : {}),
    });
  }

  async disconnect(): Promise<void> {
    const wallet = this.activeWallet;
    this.activeAccount = undefined;
    this.activeWallet = undefined;
    await wallet?.features["stellar:disconnect"]?.disconnect();
  }

  private remember(wallet: StandardStellarWallet): void {
    // Wallet Standard wallets do not have a required stable ID; name is the
    // interoperable fallback. The adapter scopes its IDs to this registry.
    const base = wallet.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "wallet";
    let id = base;
    let suffix = 2;
    while (this.wallets.has(id) && this.wallets.get(id) !== wallet) id = `${base}-${suffix++}`;
    this.wallets.set(id, wallet);
  }

  private requireWallet(id: string): StandardStellarWallet {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new WalletCapabilityError(`Wallet '${id}' is not currently discovered.`);
    return wallet;
  }

  private requireActiveWallet(): StandardStellarWallet {
    if (!this.activeWallet || !this.activeAccount) {
      throw new WalletCapabilityError("Connect a Stellar wallet before requesting a signature.");
    }
    return this.activeWallet;
  }
}

/** Freighter API shape kept structural to avoid a hard dependency on its package. */
export interface FreighterApi {
  isConnected(): Promise<boolean>;
  requestAccess(): Promise<string>;
  signTransaction(
    envelopeXdr: string,
    options: { networkPassphrase: string; address?: string }
  ): Promise<{ signedTxXdr: string }>;
  signAndSubmitTransaction?(
    envelopeXdr: string,
    options: { networkPassphrase: string; address?: string }
  ): Promise<WalletSignAndSubmitResult>;
  disconnect?(): Promise<void>;
}

/** Reference adapter for an injected Freighter API (e.g. @stellar/freighter-api). */
export class FreighterWalletAdapter implements WalletStandardAdapter {
  readonly id = "freighter";
  readonly name = "Freighter";
  private address: string | undefined;

  constructor(private readonly api: FreighterApi) {}

  async discover(): Promise<readonly WalletDescriptor[]> {
    if (!(await this.api.isConnected())) return [];
    return [{
      id: this.id,
      name: this.name,
      capabilities: {
        features: ["signTransaction", ...(this.api.signAndSubmitTransaction ? ["signAndSubmit" as const] : [])],
        networks: "*",
      },
    }];
  }

  async connect(_walletId: string, _options: WalletConnectOptions): Promise<WalletAccount> {
    if (!(await this.api.isConnected())) {
      throw new WalletCapabilityError("Freighter is not available in this browser.");
    }
    this.address = await this.api.requestAccess();
    return { address: this.address, publicKey: this.address };
  }

  async signTransaction(envelopeXdr: string, options: WalletTransactionOptions) {
    return this.api.signTransaction(envelopeXdr, {
      networkPassphrase: options.networkPassphrase,
      ...(options.address ?? this.address ? { address: options.address ?? this.address } : {}),
    });
  }

  async signAndSubmit(envelopeXdr: string, options: WalletTransactionOptions) {
    if (!this.api.signAndSubmitTransaction) {
      throw new WalletCapabilityError("Freighter does not support sign-and-submit in this integration.");
    }
    return this.api.signAndSubmitTransaction(envelopeXdr, {
      networkPassphrase: options.networkPassphrase,
      ...(options.address ?? this.address ? { address: options.address ?? this.address } : {}),
    });
  }

  async disconnect(): Promise<void> {
    this.address = undefined;
    await this.api.disconnect?.();
  }
}

/** Register the connected adapter as the SDK's ordinary transaction signer. */
export async function signerFromWalletRegistry(
  registry: WalletRegistry,
  selection: WalletSelection,
  walletId?: string
): Promise<Signer> {
  return (await registry.connectSigner(selection, walletId)).signer;
}
