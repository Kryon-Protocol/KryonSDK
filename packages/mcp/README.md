# @kryon/mcp

An MCP server that lets an LLM read Kryon markets and trade perpetuals — with
safety limits it cannot raise.

## Setup

Claude Code / Claude Desktop config:

```json
{
  "mcpServers": {
    "kryon": {
      "command": "npx",
      "args": ["-y", "@kryon/mcp"],
      "env": {
        "KRYON_NETWORK": "testnet",
        "KRYON_SECRET": "S...",
        "KRYON_MAX_ORDER_USD": "50",
        "KRYON_MAX_SESSION_USD": "500"
      }
    }
  }
}
```

Leave `KRYON_SECRET` out to run read-only — the trading tools are then not
offered to the model at all, rather than offered and failing.

## Tools

| Tool | Writes? |
|---|---|
| `list_markets` | no |
| `get_orderbook` | no |
| `get_positions` | no |
| `get_account_health` | no |
| `get_open_orders` | no |
| `place_order` | **yes** |
| `cancel_order` | yes |
| `cancel_all_orders` | yes |

## Safety

An MCP tool call is a model deciding to spend money. The model is not
adversarial, but it is fallible in ways a program is not: it can misread a
price, repeat a call, believe a crossed book is an arbitrage, or be steered by
text it read somewhere.

So the limits live **outside the model's reach**. They come from environment
variables only, and there is deliberately no tool that changes them. A model
that can raise its own limits does not have limits.

| Variable | Default | What it does |
|---|---|---|
| `KRYON_NETWORK` | `testnet` | Which venue |
| `KRYON_ALLOW_MAINNET` | `false` | Mainnet needs this **and** `KRYON_NETWORK=mainnet` |
| `KRYON_MAX_ORDER_USD` | `100` | Per-order notional ceiling |
| `KRYON_MAX_SESSION_USD` | `1000` | Total notional for the process |
| `KRYON_MAX_ORDERS` | `50` | Order count for the process |
| `KRYON_REQUIRE_CONFIRM` | `true` | Writes preview first, act only on `confirm: true` |
| `KRYON_ALLOW_CROSSED_BOOK` | `false` | Allow trading an untradeable book |

**Two-step writes.** `place_order` without `confirm: true` returns a preview —
notional, position before and after, session budget used — and places nothing.
That turns "the model placed an order" into "the model proposed an order and
then confirmed it", which is something a human reading the transcript can
actually audit.

```
PREVIEW — nothing has been placed.

  BUY 0.0001 BTC-PERP @ 40000
  notional        ~4.00 USD (at 40000)
  position now    0
  position after  0.0001
  network         TESTNET
  session so far  0 orders, 0.00 USD of 100 USD allowed
```

**Crossed books are refused.** Parts of Kryon's live books are crossed or
locked — orders that should have matched and did not, because their owner
cannot settle them. It looks like free money to a model. It is not takeable.

**Everything is audited.** Each call is recorded with its arguments and whether
it previewed, executed, or was refused.

## Direct LLM API use

The same tools, without MCP:

```ts
import { anthropicTools, TOOLS_BY_NAME, PolicyEnforcer, policyFromEnv } from "@kryon/mcp";

const tools = anthropicTools();   // or openaiTools()
```

You are responsible for running them through a `PolicyEnforcer` yourself.
