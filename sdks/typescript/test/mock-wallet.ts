import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  WalletAccount,
  WalletCapabilities,
  WalletConnectOptions,
  WalletDescriptor,
  WalletStandardAdapter,
  WalletTransactionOptions,
} from "../src/wallet-standard.js";

/** Test-only wallet: the private key stays inside this mock, never in the SDK. */
export class MockWalletAdapter implements WalletStandardAdapter {
  readonly id = "mock-stellar-wallet";
  readonly name = "Mock Stellar Wallet";
  readonly capabilities: WalletCapabilities = {
    features: ["signTransaction", "signAndSubmit"],
    networks: [Networks.TESTNET],
  };
  readonly keypair: Keypair;
  private account: WalletAccount | undefined;

  constructor(keypair = Keypair.random()) {
    this.keypair = keypair;
  }

  async discover(): Promise<readonly WalletDescriptor[]> {
    return [{ id: this.id, name: this.name, capabilities: this.capabilities }];
  }

  async connect(_walletId: string, _options: WalletConnectOptions): Promise<WalletAccount> {
    const address = this.keypair.publicKey();
    this.account = { address, publicKey: address };
    return this.account;
  }

  async signTransaction(
    envelopeXdr: string,
    options: WalletTransactionOptions
  ): Promise<{ signedTxXdr: string }> {
    const transaction = TransactionBuilder.fromXDR(envelopeXdr, options.networkPassphrase);
    transaction.sign(this.keypair);
    return { signedTxXdr: transaction.toXDR() };
  }

  async signAndSubmit(
    envelopeXdr: string,
    options: WalletTransactionOptions
  ): Promise<{ hash: string; signedTxXdr: string }> {
    const { signedTxXdr } = await this.signTransaction(envelopeXdr, options);
    return { hash: "mock-submission", signedTxXdr };
  }

  async disconnect(): Promise<void> {
    this.account = undefined;
  }
}
