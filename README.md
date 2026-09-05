# Kryon SDK

TypeScript SDK for [Kryon](https://kryonprotocol.live) — an on-chain perpetuals
CLOB on Stellar/Soroban. Built for trading bots and AI agents.

> **Status: early development.** The signing layer is complete and conformance-
> tested against the live protocol. The client, runtime, and CLI are in progress.

## Why Kryon is easy to trade programmatically

**You sign once and you are done.** Kryon settles fills autonomously: the
matcher takes the SEP-53 signature attached to your order and submits
`settle_fill_signed` on chain itself. Your bot does not have to stay online to
co-sign a settlement, and there is no second round trip between matching and
finality. Sign the order, disconnect, come back later to a settled position.

Everything else follows from that: orders are self-custodied signed intents,
margin lives in a vault contract you control, and nothing in the venue can move
your funds without a signature you produced.

## Packages

| Package | What it is |
|---|---|
| `@kryon/sdk` | Order signing, market data, account operations |
| `@kryon/agent` | Strategy runtime with risk guards and paper trading *(planned)* |
| `@kryon/mcp` | MCP server so an LLM can trade Kryon *(planned)* |
| `kryon-agent` | CLI: one-command testnet onboarding *(planned)* |

## Repository layout

```
packages/sdk/        the core SDK
conformance/         signing vectors shared with the protocol and the contract
examples/            runnable strategies
```

## Conformance

Kryon verifies order signatures **twice**: off-chain at intake, and again
on-chain inside the `perp-order-gateway` contract during settlement. Both check
the same bytes, so a signing implementation that is even one byte off produces
orders that can be matched but never settled.

`conformance/vectors.json` pins those bytes. It is generated from the protocol's
own implementation and asserted by every SDK that speaks the wire format. See
[`conformance/README.md`](./conformance/README.md).

## Development

```sh
pnpm install
pnpm test        # includes the conformance suite
pnpm typecheck
```

## License

Apache-2.0
