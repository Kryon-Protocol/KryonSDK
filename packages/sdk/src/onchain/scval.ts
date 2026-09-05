/** ScVal conversions matching the contracts' ABI. */

import { Address, xdr } from "@stellar/stellar-sdk";

export function addressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

export function u32ToScVal(value: number): xdr.ScVal {
  return xdr.ScVal.scvU32(value);
}

export function i128ToScVal(value: bigint): xdr.ScVal {
  const high = BigInt.asIntN(64, value >> 64n);
  const low = BigInt.asUintN(64, value);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(high),
      lo: new xdr.Uint64(low),
    }),
  );
}

export function u64ToScVal(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(new xdr.Uint64(value));
}

export function scValToI128(value: xdr.ScVal): bigint {
  const parts = value.i128();
  return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
}
