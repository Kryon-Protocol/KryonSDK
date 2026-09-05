# Conformance vectors

`vectors.json` is the contract between every Kryon signing implementation:

| Implementation | Must reproduce |
|---|---|
| `@kryon/sdk` (TypeScript) | `canonical_message`, `sep53_digest_hex`, `signature_base64` |
| `perp-order-gateway` (Rust, on-chain) | `canonical_message` bytes and the digest it verifies |
| `kryon-sdk` (Python, planned) | same as the TS SDK |

The vectors are **generated from the live protocol implementation**
(`client/lib/market/signing-message.ts` in the Kryon monorepo) by
`generate.ts`, so they are not circular with respect to the SDK: the SDK is
asserted against the protocol, never against itself.

## Regenerating

From the Kryon monorepo's `client/` directory:

```sh
npx tsx path/to/KryonSDK/conformance/generate.ts > path/to/KryonSDK/conformance/vectors.json
```

A regenerated file that differs in any `canonical_message` is a **wire-format
change**. That is a breaking change to every deployed bot and must be matched
by a contract upgrade — never commit one to make a failing test pass.

## The test key

`test_key` is derived deterministically from the constant seed
`"kryon-sdk-conformance-vectors-v1"` so anyone can reproduce it. It is
published here on purpose. **Never fund this account.**
