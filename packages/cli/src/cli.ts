/**
 * `kryon-agent` — CLI for Kryon trading agents.
 */

import { writeFileSync, existsSync } from "node:fs";
import {
  KeypairSigner,
  KryonClient,
  isNetworkId,
  type NetworkId,
} from "@kryon/sdk";
import { onboard } from "./onboard.js";

const log = (m = "") => console.log(m);

/**
 * Reported as a clean one-line error, not a stack trace: a CLI user reading
 * "no key. Pass --secret" is helped; one reading a stack trace is not.
 */
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function network(): NetworkId {
  const value = arg("network") ?? process.env.KRYON_NETWORK ?? "testnet";
  if (!isNetworkId(value)) {
    fail(`unknown network "${value}" (expected mainnet or testnet)`);
  }
  return value;
}

function signer(): KeypairSigner {
  const secret = arg("secret") ?? process.env.KRYON_SECRET;
  if (secret === undefined) {
    fail("no key. Pass --secret or set KRYON_SECRET (kryon-agent init makes one).");
  }
  try {
    return new KeypairSigner(secret);
  } catch {
    fail("that does not look like a Stellar secret key (should start with S).");
  }
}

function client(withSigner = true): KryonClient {
  return new KryonClient({
    network: network(),
    ...(withSigner ? { signer: signer() } : {}),
  });
}

/**
 * Mainnet is real money. Every writing command asks before touching it, unless
 * the caller has explicitly said not to.
 */
function confirmMainnet(action: string): void {
  if (network() !== "mainnet" || flag("yes")) return;
  fail(
    `${action} on MAINNET uses real funds. Re-run with --yes if that is what you meant.`,
  );
}

const HELP = `
kryon-agent — CLI for Kryon trading agents

  init              Create a testnet account: fund it, add the USDC trustline,
                    and deposit margin. Writes a .env you can use immediately.
  doctor            Check everything a bot needs before it trades.
  balance           Wallet and vault balances, and margin health.
  positions         Open positions.
  orders            Resting orders.
  cancel-all        Cancel every resting order. The manual kill switch.
  markets           List the markets this venue actually serves.

Options
  --network <id>    mainnet or testnet (default testnet)
  --secret <S…>     signing key; or set KRYON_SECRET
  --deposit <n>     init: USDC to deposit as margin (default 50)
  --funding-secret  init: an account holding testnet USDC to send some from
  --market <sym>    scope a command to one market
  --env <path>      init: where to write the env file (default .env)
  --yes             skip the mainnet confirmation
`;

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "init": {
      if (network() === "mainnet") {
        fail("init is testnet only. Never generate a mainnet key with a CLI flag.");
      }
      log("Setting up a Kryon testnet account\n");

      const result = await onboard({
        ...(arg("secret") ? { secret: arg("secret")! } : {}),
        ...(arg("funding-secret") ? { fundingSecret: arg("funding-secret")! } : {}),
        depositAmount: Number(arg("deposit") ?? 50),
        log: (m) => log(m),
      });

      const envPath = arg("env") ?? ".env";
      const body =
        `KRYON_NETWORK=testnet\n` +
        `KRYON_SECRET=${result.secret}\n` +
        `KRYON_ADDRESS=${result.publicKey}\n`;

      if (existsSync(envPath) && !flag("yes")) {
        log("");
        log(`  ${envPath} already exists; not overwriting it. Your key:`);
        log("");
        log(`  KRYON_SECRET=${result.secret}`);
      } else {
        writeFileSync(envPath, body);
        log("");
        log(`  wrote ${envPath}`);
      }

      log("");
      log("  Keep that secret out of version control.");
      log("");
      log("  Next:  kryon-agent doctor");
      break;
    }

    case "doctor": {
      const net = network();
      log(`Checking ${net}\n`);
      const readonly = new KryonClient({ network: net });
      let problems = 0;

      const status = await readonly.status().catch(() => null);
      if (status?.ok) {
        log(`  venue        ok, ${status.markets.length} market(s) listed`);
      } else {
        log(`  venue        UNREACHABLE`);
        problems += 1;
      }

      const time = await readonly.time().catch(() => null);
      if (time && !time.measured) {
        // Do not report an unmeasured zero as "in sync".
        log(`  clock        not measurable (this venue has no /api/time)`);
      } else if (time) {
        const skew = Math.abs(time.offsetMs);
        if (skew > 2000) {
          log(`  clock        OFF BY ${time.offsetMs}ms — orders may be rejected as expiring too soon`);
          problems += 1;
        } else {
          log(`  clock        ok (${time.offsetMs}ms from the venue)`);
        }
      }

      const markets = await readonly.listMarkets().catch(() => []);
      for (const market of markets.slice(0, 8)) {
        const book = await readonly.orderbook(market.symbol).catch(() => null);
        const oracle = Number(market.lastOraclePrice);
        const notes: string[] = [];
        if (!(oracle > 0)) {
          notes.push("NO ORACLE PRICE");
          problems += 1;
        }
        if (book?.crossed) {
          notes.push("BOOK CROSSED — spread is not takeable");
          problems += 1;
        }
        if (book && book.bids.length === 0 && book.asks.length === 0) {
          notes.push("empty book");
        }
        log(
          `  ${market.symbol.padEnd(11)} ${oracle > 0 ? oracle : "-"}` +
            (notes.length ? `  [${notes.join("; ")}]` : ""),
        );
      }

      const secret = arg("secret") ?? process.env.KRYON_SECRET;
      if (!secret) {
        log("\n  no key configured, so account checks were skipped");
      } else {
        const authed = client();
        log("");
        log(`  account      ${authed.address}`);
        const [wallet, vault, health] = await Promise.all([
          authed.walletBalance().catch(() => "?"),
          authed.vaultBalance().catch(() => "?"),
          authed.accountHealth().catch(() => null),
        ]);
        log(`  wallet USDC  ${wallet}`);
        log(`  vault USDC   ${vault}`);
        if (Number(vault) <= 0) {
          log("               no margin deposited — orders will rest but can never settle");
          problems += 1;
        }
        if (health?.liquidatable) {
          log(`  margin       LIQUIDATABLE (ratio ${health.marginRatio})`);
          problems += 1;
        } else if (health) {
          log(`  margin       ratio ${health.marginRatio}, free ${health.freeCollateral}`);
        }
      }

      log("");
      log(
        problems === 0
          ? "  All good."
          : `  ${problems} thing${problems === 1 ? "" : "s"} need attention.`,
      );
      if (problems > 0) process.exitCode = 1;
      break;
    }

    case "balance": {
      const c = client();
      const [wallet, vault, health] = await Promise.all([
        c.walletBalance(),
        c.vaultBalance(),
        c.accountHealth(),
      ]);
      log(`account   ${c.address}`);
      log(`wallet    ${wallet} USDC`);
      log(`vault     ${vault} USDC (margin)`);
      if (health) {
        log(`equity    ${health.equity}`);
        log(`free      ${health.freeCollateral}`);
        log(`ratio     ${health.marginRatio}${health.liquidatable ? "  LIQUIDATABLE" : ""}`);
      }
      break;
    }

    case "positions": {
      const positions = await client().positions();
      if (positions.length === 0) {
        log("no open positions");
        break;
      }
      for (const p of positions) {
        log(
          `market ${p.marketId}  ${p.isLong ? "long " : "short"}  ` +
            `size ${p.size}  entry ${p.entryPrice}  margin ${p.margin}`,
        );
      }
      break;
    }

    case "orders": {
      const c = client();
      const orders = await c.openOrders(
        arg("market") ? { market: arg("market")! } : {},
      );
      if (orders.length === 0) {
        log("no resting orders");
        break;
      }
      for (const o of orders) {
        log(
          `market ${o.marketId}  ${o.isLong ? "buy " : "sell"}  ` +
            `${o.remainingSize} @ ${o.limitPrice}  nonce ${o.nonce}`,
        );
      }
      break;
    }

    case "cancel-all": {
      confirmMainnet("cancel-all");
      const c = client();
      const cancelled = await c.cancelAll(
        arg("market") ? { market: arg("market")! } : {},
      );
      log(`cancelled ${cancelled.length} order(s)`);
      break;
    }

    case "markets": {
      const markets = await client(false).listMarkets();
      for (const m of markets) {
        log(
          `${String(m.marketId).padStart(2)}  ${m.symbol.padEnd(11)} ` +
            `oracle ${String(m.lastOraclePrice).padStart(12)}  ` +
            `tick ${m.tickSizes?.[0] ?? "?"}  ` +
            `max ${(m.maxLeverageBps ?? 0) / 10000}x` +
            (m.active ? "" : "  [inactive]"),
        );
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined:
      log(HELP);
      break;

    default:
      fail(`unknown command "${command}". Try: kryon-agent help`);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
