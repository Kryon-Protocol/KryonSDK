/**
 * Testnet onboarding: keypair -> XLM -> USDC trustline -> vault deposit.
 *
 * This is the drop-off point for anyone new to Stellar, because "fund an
 * account" is four separate concepts: an account needs XLM to exist at all, a
 * trustline before it can hold USDC, USDC from somewhere, and then a deposit
 * into a contract before any of it counts as margin.
 *
 * Testnet only, and it refuses to run against mainnet — friendbot does not
 * exist there and the failure modes are real money.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { KeypairSigner, KryonClient, getNetworkConfig } from "@kryon/sdk";

export interface OnboardResult {
  publicKey: string;
  secret: string;
  fundedXlm: boolean;
  trustlineAdded: boolean;
  usdcReceived: string;
  deposited: string;
}

export async function onboard(options: {
  secret?: string;
  depositAmount?: number;
  fundingSecret?: string;
  log: (message: string) => void;
}): Promise<OnboardResult> {
  const network = getNetworkConfig("testnet");
  const log = options.log;

  const keypair = options.secret ? Keypair.fromSecret(options.secret) : Keypair.random();
  const address = keypair.publicKey();
  log(`account ${address}`);

  const horizon = new Horizon.Server(network.horizonUrl);

  // 1. XLM, so the account exists at all.
  let fundedXlm = false;
  try {
    await horizon.loadAccount(address);
    log("  XLM        already funded");
    fundedXlm = true;
  } catch {
    log("  XLM        requesting from friendbot…");
    const res = await fetch(`${network.friendbotUrl}?addr=${address}`);
    if (!res.ok) {
      throw new Error(`friendbot refused (${res.status}). Try again in a moment.`);
    }
    await waitFor(() => horizon.loadAccount(address), "account creation");
    log("  XLM        funded");
    fundedXlm = true;
  }

  // 2. Trustline, so it can hold USDC at all.
  const usdc = new Asset("USDC", network.assets.usdcIssuer);
  const account = await horizon.loadAccount(address);
  const hasTrustline = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === network.assets.usdcIssuer,
  );

  let trustlineAdded = false;
  if (hasTrustline) {
    log("  trustline  already present");
    trustlineAdded = true;
  } else {
    log("  trustline  adding USDC…");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    tx.sign(keypair);
    await horizon.submitTransaction(tx);
    log("  trustline  added");
    trustlineAdded = true;
  }

  // 3. USDC itself. Nothing dispenses testnet USDC, so this needs a source.
  if (options.fundingSecret) {
    const funder = Keypair.fromSecret(options.fundingSecret);
    log(`  USDC       sending from ${funder.publicKey().slice(0, 8)}…`);
    const funderAccount = await horizon.loadAccount(funder.publicKey());
    const tx = new TransactionBuilder(funderAccount, {
      fee: "100000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: address,
          asset: usdc,
          amount: String(options.depositAmount ?? 50),
        }),
      )
      .setTimeout(60)
      .build();
    tx.sign(funder);
    await horizon.submitTransaction(tx);
    log("  USDC       received");
  }

  const client = new KryonClient({
    network: "testnet",
    signer: new KeypairSigner(keypair),
  });

  const usdcBalance = await client.walletBalance();
  log(`  USDC       balance ${usdcBalance}`);

  // 4. Deposit, so it counts as margin.
  let deposited = "0";
  const wanted = options.depositAmount ?? 50;
  const available = Number(usdcBalance);
  if (available <= 0) {
    log("");
    log("  No USDC in the account, so nothing was deposited as margin.");
    log("  Testnet USDC is not dispensed by friendbot. You can still place");
    log("  orders without it — intake only checks your signature — but a fill");
    log("  can never settle. Pass --funding-secret with an account that holds");
    log("  testnet USDC, or ask in the Kryon channel.");
  } else {
    const amount = Math.min(wanted, available);
    log(`  deposit    ${amount} USDC into the vault…`);
    await client.deposit(amount);
    deposited = String(amount);
    log(`  deposit    done`);
  }

  return {
    publicKey: address,
    secret: keypair.secret(),
    fundedXlm,
    trustlineAdded,
    usdcReceived: usdcBalance,
    deposited,
  };
}

async function waitFor<T>(fn: () => Promise<T>, what: string, attempts = 20): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`timed out waiting for ${what}: ${String(lastError)}`);
}
