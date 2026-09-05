/**
 * Per-network configuration.
 *
 * Both networks are baked in, mirroring `client/config/networks.ts` in the
 * protocol repo. Everything here is public — contract ids, RPC endpoints,
 * network passphrases.
 *
 * The passphrase is the important field: it is the domain separator inside
 * every order signature, so an intent signed for testnet is cryptographically
 * incapable of being replayed on mainnet. Nothing in this SDK infers a network
 * implicitly; you name it when you construct a client.
 */

export const NETWORK_IDS = ["mainnet", "testnet"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId {
  return (
    typeof value === "string" &&
    (NETWORK_IDS as readonly string[]).includes(value)
  );
}

export interface ContractSet {
  governance: string;
  oracleAdapter: string;
  vault: string;
  engine: string;
  orderGateway: string;
  insurance: string;
  liquidation: string;
  risk: string;
}

export interface AssetSet {
  /** Stellar Asset Contract id for native XLM. */
  nativeXlm: string;
  /** Stellar Asset Contract id for USDC — the collateral asset. */
  usdc: string;
  /** Classic issuer account for USDC, needed to add a trustline. */
  usdcIssuer: string;
}

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  /** Stellar network passphrase. Also the gateway's signing domain. */
  passphrase: string;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Horizon endpoint, for classic operations like trustlines. */
  horizonUrl: string;
  /** Default Kryon API origin. */
  apiUrl: string;
  /** Realtime stream endpoint, or null when the venue has none. */
  wsUrl: string | null;
  /** Friendbot endpoint, testnet only. */
  friendbotUrl: string | null;
  contracts: ContractSet;
  assets: AssetSet;
}

const MAINNET: NetworkConfig = {
  id: "mainnet",
  label: "Stellar Mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  horizonUrl: "https://horizon.stellar.org",
  apiUrl: "https://kryonprotocol.live",
  wsUrl: "wss://ws.kryonprotocol.live",
  friendbotUrl: null,
  // Deployed 2026-07-07 — infra/deploy/mainnet-deployment.json
  contracts: {
    governance: "CDSIEH7UZ62BT523G3RGJQGJHE7AI4EV265ESKZB672GTIEZNBYPYDXU",
    oracleAdapter: "CD3ZFYZPLJ6W2KO6HD7HE5P5Q27M5N6ITUPHQDRP23NBIVKE6WTUY25F",
    vault: "CDXGTJQS3XLGXSWDUHKMS5PBBFRRKRXRWH3HTBFNXBIAYEZNDTDKLR4J",
    engine: "CD6OMHCRDDBDO7I57HCUU52RORFPP7DUIRULWFBOX5WLCO5H2OB3W6LZ",
    orderGateway: "CBA2PSRHSIFTSUAFZWMF6CARNO7YR52PWLWLEXYVRACORS2RXNO2DUTJ",
    insurance: "CCBEJ3F2PUV5OA4JNX3CPSOJFQMYMFDPLNANR2GJZVQEEBFMB6JYNL54",
    liquidation: "CBGSXCZTZOSBMM5RLGZWWLE2USNAXL5ZKCHTZQ6DOKBD3PIEUJXFYDRO",
    risk: "CBHZWEIKXULFIH6DCSS7W6BJ3YUVQ5TJFYPP4UKQC4NKLNAF7VLPNVUI",
  },
  assets: {
    nativeXlm: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
};

const TESTNET: NetworkConfig = {
  id: "testnet",
  label: "Stellar Testnet",
  passphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  apiUrl: "https://kryonprotocol.live",
  wsUrl: "wss://testnet-keepers-production.up.railway.app",
  friendbotUrl: "https://friendbot.stellar.org",
  // Redeployed 2026-09-05 — infra/deploy/testnet-deployment-v2.json. The
  // 2026-07-05 deployment's admin key was lost, so these are fresh contracts.
  contracts: {
    governance: "CA4RGOU5S74EZHG6P5PKKMB5SR7TRXLY7DMJOTLUG6F6XE4P6YZSHH34",
    oracleAdapter: "CD5NFH3JWGIAPTRD4R5OBBJNMJKR3SEL2WXOXG5SH3YT7Q65VVNUZUI4",
    vault: "CCFVY4ISEKH5MOOONDDPZXE3ZH7DMEHH7P3GPT5HOZOXD4NMIVPOKK6P",
    engine: "CAF5OD5KKQOJUW6C3RKSBT2B3U4FZBAO2GM5CN5HQY37FPOL3EHNLF5P",
    orderGateway: "CDGWXDAFGPARVZ2VRFTDAJK5MIJ326SPBE4UWZF5CD4CQEEKPVIIDARQ",
    insurance: "CAHX6XS4AUO3BF5JIVIPEW3ZNP7S6FDWZ3KXLW5LAMPEFO57H7IXA7MC",
    liquidation: "CBQC3MTE5INOJKBWO66TBZ3EVGKQDJCUIBJAEFAABK5X2AKILJYBEMOL",
    risk: "CDZVGUXWAE5NZSVAQ62NTKJUBBXWJD6OCXBHNYQHYLX4KPWV6AF7PANX",
  },
  assets: {
    nativeXlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
};

export const NETWORKS: Readonly<Record<NetworkId, NetworkConfig>> = Object.freeze({
  mainnet: MAINNET,
  testnet: TESTNET,
});

export function getNetworkConfig(network: NetworkId): NetworkConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `Unknown network ${JSON.stringify(network)}. Expected one of: ${NETWORK_IDS.join(", ")}`,
    );
  }
  return config;
}
