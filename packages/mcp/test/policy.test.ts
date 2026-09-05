import { describe, expect, it } from "vitest";
import { PolicyEnforcer, PolicyViolation, policyFromEnv } from "../src/policy.js";

const base = {
  KRYON_NETWORK: "testnet",
} as NodeJS.ProcessEnv;

describe("policy from environment", () => {
  it("defaults to testnet with conservative limits", () => {
    const policy = policyFromEnv({} as NodeJS.ProcessEnv);
    expect(policy.network).toBe("testnet");
    expect(policy.maxOrderNotionalUsd).toBe(100);
    expect(policy.requireConfirm).toBe(true);
    expect(policy.refuseCrossedBook).toBe(true);
  });

  it("refuses mainnet unless it is opted into twice", () => {
    expect(() => policyFromEnv({ KRYON_NETWORK: "mainnet" } as NodeJS.ProcessEnv)).toThrow(
      /Refusing to start on mainnet/,
    );
    const allowed = policyFromEnv({
      KRYON_NETWORK: "mainnet",
      KRYON_ALLOW_MAINNET: "true",
    } as NodeJS.ProcessEnv);
    expect(allowed.network).toBe("mainnet");
  });

  it("rejects a nonsense limit rather than falling back to a default", () => {
    expect(() =>
      policyFromEnv({ ...base, KRYON_MAX_ORDER_USD: "-5" } as NodeJS.ProcessEnv),
    ).toThrow(/positive number/);
    expect(() =>
      policyFromEnv({ ...base, KRYON_MAX_ORDER_USD: "banana" } as NodeJS.ProcessEnv),
    ).toThrow(/positive number/);
  });

  it("rejects an unknown network", () => {
    expect(() =>
      policyFromEnv({ KRYON_NETWORK: "devnet" } as NodeJS.ProcessEnv),
    ).toThrow(/mainnet or testnet/);
  });
});

describe("enforcement", () => {
  const policy = policyFromEnv({
    ...base,
    KRYON_MAX_ORDER_USD: "100",
    KRYON_MAX_SESSION_USD: "250",
    KRYON_MAX_ORDERS: "3",
  } as NodeJS.ProcessEnv);

  it("blocks an order over the per-order limit", () => {
    const e = new PolicyEnforcer(policy);
    expect(() => e.checkOrder(150)).toThrow(PolicyViolation);
    expect(() => e.checkOrder(99)).not.toThrow();
  });

  it("blocks once the session notional would be exceeded", () => {
    const e = new PolicyEnforcer(policy);
    e.checkOrder(100); e.recordOrder(100);
    e.checkOrder(100); e.recordOrder(100);
    // 200 traded; a third 100 would reach 300, over the 250 cap.
    expect(() => e.checkOrder(100)).toThrow(/session/);
    expect(() => e.checkOrder(40)).not.toThrow();
  });

  it("blocks once the session order count is reached", () => {
    const e = new PolicyEnforcer(policy);
    for (let i = 0; i < 3; i += 1) { e.checkOrder(1); e.recordOrder(1); }
    expect(() => e.checkOrder(1)).toThrow(/already placed 3 orders/);
  });

  it("refuses an order whose notional cannot be computed", () => {
    const e = new PolicyEnforcer(policy);
    expect(() => e.checkOrder(Number.NaN)).toThrow(PolicyViolation);
    expect(() => e.checkOrder(-1)).toThrow(PolicyViolation);
  });

  it("has no method that raises its own limits", () => {
    const e = new PolicyEnforcer(policy);
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(e)),
      ...Object.keys(e),
    ];
    // The model must not be able to widen what it is allowed to do.
    expect(names.filter((n) => /^set|raise|update|configure/i.test(n))).toEqual([]);
  });

  it("records an audit trail", () => {
    const e = new PolicyEnforcer(policy);
    e.record({ tool: "place_order", arguments: { size: 1 }, outcome: "preview" });
    e.record({ tool: "place_order", arguments: { size: 1 }, outcome: "executed" });
    expect(e.audit.map((a) => a.outcome)).toEqual(["preview", "executed"]);
    expect(e.audit[0]!.at).toMatch(/^\d{4}-/);
  });
});
