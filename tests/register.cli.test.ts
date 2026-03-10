import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";

const sdkMock = {
  api: {
    getOperators: jest.fn(),
    getOwnerNonce: jest.fn(),
  },
  utils: {
    generateKeyShares: jest.fn(),
  },
  clusters: {
    registerValidatorsRawData: jest.fn(),
  },
};

const transactionMock = {
  getSafeProtocolKit: jest.fn(),
  createApprovedMultiSigTx: jest.fn(),
  checkAndExecuteSignatures: jest.fn(),
};

const generateMock = {
  createValidatorKeys: jest.fn(),
};

const viemMock = {
  createPublicClient: jest.fn(() => ({ kind: "public" })),
  createWalletClient: jest.fn(() => ({ kind: "wallet" })),
  http: jest.fn((url?: string) => ({ transportUrl: url })),
  parseEther: jest.fn(() => 100000000000000000n),
};

jest.mock("@ssv-labs/ssv-sdk", () => ({
  SSVSDK: jest.fn(() => sdkMock),
  chains: {
    mainnet: { id: 1 },
    hoodi: { id: 560048 },
  },
}));

jest.mock("viem", () => viemMock);

jest.mock("viem/accounts", () => ({
  privateKeyToAccount: jest.fn(() => ({ address: "0xowner" })),
}));

jest.mock("../src/transaction.js", () => ({
  getSafeProtocolKit: (...args: unknown[]) =>
    transactionMock.getSafeProtocolKit(...args),
  createApprovedMultiSigTx: (...args: unknown[]) =>
    transactionMock.createApprovedMultiSigTx(...args),
  checkAndExecuteSignatures: (...args: unknown[]) =>
    transactionMock.checkAndExecuteSignatures(...args),
}));

jest.mock("../src/generate.js", () => ({
  createValidatorKeys: (...args: unknown[]) =>
    generateMock.createValidatorKeys(...args),
}));

type ProgressBatch = {
  startIndex: number;
  count: number;
  nonce: number;
  status: "prepared" | "approved" | "executed";
  safeTxHash?: string;
  executeTxHash?: string;
  updatedAt: string;
};

function buildRunId(options: {
  chainId: number;
  safeAddress: string;
  ssvContract: string;
  operatorIds: number[];
  chunkSize: number;
  keystoreDir: string;
  files: string[];
  totalKeys: number;
}) {
  const keystoreFilesHash = createHash("sha256")
    .update(JSON.stringify(options.files))
    .digest("hex");

  const payload = {
    chainId: options.chainId,
    safeAddress: options.safeAddress.toLowerCase(),
    ssvContract: options.ssvContract.toLowerCase(),
    operatorIds: [...options.operatorIds].sort((a, b) => a - b),
    chunkSize: options.chunkSize,
    keystoreDir: options.keystoreDir,
    keystoreFilesHash,
    totalKeys: options.totalKeys,
  };

  return { runId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), keystoreFilesHash };
}

async function createKeystoreDir(files: Array<{ name: string; content: unknown }>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ssv-multisig-test-"));
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    await writeFile(path.join(dir, file.name), JSON.stringify(file.content), "utf8");
  }
  return dir;
}

async function runRegister(operatorIds: string, keystoreDir: string) {
  let registerModule: {
    register: {
      parseAsync: (
        args: string[],
        opts: { from: "user" },
      ) => Promise<unknown>;
    };
  } | null = null;

  jest.isolateModules(() => {
    registerModule = require("../src/register");
  });

  if (!registerModule) {
    throw new Error("Failed to load register module");
  }

  return registerModule.register.parseAsync([operatorIds, "-k", keystoreDir], {
    from: "user",
  });
}

async function runRegisterWithRenameFailure(operatorIds: string, keystoreDir: string) {
  let registerModule: {
    register: {
      parseAsync: (
        args: string[],
        opts: { from: "user" },
      ) => Promise<unknown>;
    };
  } | null = null;

  jest.isolateModules(() => {
    jest.doMock("fs/promises", () => {
      const actual = jest.requireActual("fs/promises") as typeof import("fs/promises");
      return {
        ...actual,
        rename: jest.fn(async () => {
          throw new Error("rename-failed");
        }),
      };
    });
    registerModule = require("../src/register");
  });

  if (!registerModule) {
    throw new Error("Failed to load register module");
  }

  try {
    return await registerModule.register.parseAsync([operatorIds, "-k", keystoreDir], {
      from: "user",
    });
  } finally {
    jest.dontMock("fs/promises");
  }
}

function setRequiredEnv() {
  process.env.PRIVATE_KEY = "0x" + "1".repeat(64);
  process.env.SAFE_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
  process.env.RPC_ENDPOINT = "https://rpc.example.org";
  process.env.SSV_CONTRACT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  process.env.SUBGRAPH_API = "https://graph.example.org";
  process.env.SUBGRAPH_API_KEY = "graph-key";
  process.env.KEYSTORE_PASSWORD = "secret";
  process.env.TESTNET = "";
  process.env.CHUNK_SIZE = "2";
}

function setupBaseMocks() {
  sdkMock.api.getOperators.mockResolvedValue([
    { id: "1", validatorCount: "10", publicKey: "op-1" },
    { id: "2", validatorCount: "20", publicKey: "op-2" },
    { id: "3", validatorCount: "30", publicKey: "op-3" },
    { id: "4", validatorCount: "40", publicKey: "op-4" },
  ]);
  sdkMock.utils.generateKeyShares.mockImplementation(({ keystore }: { keystore: string[] }) =>
    keystore.map((_, i) => ({ publicKey: `0xpub-${i}`, sharesData: `0xshare-${i}` })),
  );
  sdkMock.clusters.registerValidatorsRawData.mockResolvedValue({ args: "ignored", data: "0xdata" });

  transactionMock.getSafeProtocolKit.mockResolvedValue({ kind: "safe-kit" });
  transactionMock.createApprovedMultiSigTx.mockResolvedValue({
    safeTransaction: { id: "safe-tx" },
    safeTxHash: "0xsafehash",
  });
  transactionMock.checkAndExecuteSignatures.mockResolvedValue("0xexecuted");
}

describe("register CLI (-k mode)", () => {
  const initialEnv = { ...process.env };
  const tempDirs: string[] = [];

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...initialEnv };
    setRequiredEnv();
    setupBaseMocks();
    generateMock.createValidatorKeys.mockResolvedValue({
      keystores: [],
      deposit_data: [],
      masterSK: new Uint8Array(),
      masterSKHash: "0x" + "0".repeat(64),
    });

    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast when RPC_ENDPOINT is invalid", async () => {
    process.env.RPC_ENDPOINT = "not-a-url";
    const dir = await createKeystoreDir([{ name: "keystore-m_12381_3600_0_0_0-x.json", content: { id: "k0" } }]);
    tempDirs.push(dir);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow("RPC endpoint must be a valid URL");
  });

  it("loads keystores deterministically by validator index", async () => {
    process.env.CHUNK_SIZE = "40";
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_2_0_0-a.json", content: { id: "k2" } },
      { name: "keystore-m_12381_3600_0_0_0-b.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-c.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);

    expect(sdkMock.utils.generateKeyShares).toHaveBeenCalledTimes(1);
    expect(generateMock.createValidatorKeys).not.toHaveBeenCalled();
    const callArg = sdkMock.utils.generateKeyShares.mock.calls[0][0];
    expect(callArg.keystore).toEqual([
      JSON.stringify({ id: "k0" }),
      JSON.stringify({ id: "k1" }),
      JSON.stringify({ id: "k2" }),
    ]);
  });

  it("creates progress and processes registrations in chunks", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValueOnce(10).mockResolvedValueOnce(12);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
      { name: "keystore-m_12381_3600_3_0_0-d.json", content: { id: "k3" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);

    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(2);
    expect(transactionMock.checkAndExecuteSignatures).toHaveBeenCalledTimes(2);

    const progressRaw = await readFile(path.join(dir, ".ssv-register-progress.json"), "utf8");
    const progress = JSON.parse(progressRaw);
    expect(progress.nextIndex).toBe(4);
    expect(progress.lastKnownOwnerNonce).toBe(14);
    expect(progress.batches).toHaveLength(2);
    expect(progress.batches.every((b: ProgressBatch) => b.status === "executed")).toBe(true);
  });

  it("resumes from nextIndex in existing progress file", async () => {
    const files = [
      "keystore-m_12381_3600_0_0_0-a.json",
      "keystore-m_12381_3600_1_0_0-b.json",
      "keystore-m_12381_3600_2_0_0-c.json",
      "keystore-m_12381_3600_3_0_0-d.json",
    ];
    const dir = await createKeystoreDir([
      { name: files[0], content: { id: "k0" } },
      { name: files[1], content: { id: "k1" } },
      { name: files[2], content: { id: "k2" } },
      { name: files[3], content: { id: "k3" } },
    ]);
    tempDirs.push(dir);

    const { runId, keystoreFilesHash } = buildRunId({
      chainId: 1,
      safeAddress: process.env.SAFE_ADDRESS!,
      ssvContract: process.env.SSV_CONTRACT!,
      operatorIds: [1, 2, 3, 4],
      chunkSize: 2,
      keystoreDir: dir,
      files,
      totalKeys: 4,
    });

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId,
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash,
          totalKeys: 4,
          initialOwnerNonce: 10,
          nextIndex: 2,
          lastKnownOwnerNonce: 12,
          batches: [
            {
              startIndex: 0,
              count: 2,
              nonce: 10,
              status: "executed",
              safeTxHash: "0xsafe-1",
              executeTxHash: "0xexec-1",
              updatedAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    sdkMock.api.getOwnerNonce.mockResolvedValueOnce(12).mockResolvedValueOnce(12);
    await runRegister("1,2,3,4", dir);

    const callArg = sdkMock.utils.generateKeyShares.mock.calls[0][0];
    expect(callArg.keystore).toEqual([
      JSON.stringify({ id: "k2" }),
      JSON.stringify({ id: "k3" }),
    ]);
    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(1);
  });

  it("strictly rejects nonce drift outside tracked batches", async () => {
    const files = [
      "keystore-m_12381_3600_0_0_0-a.json",
      "keystore-m_12381_3600_1_0_0-b.json",
    ];
    const dir = await createKeystoreDir([
      { name: files[0], content: { id: "k0" } },
      { name: files[1], content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    const { runId, keystoreFilesHash } = buildRunId({
      chainId: 1,
      safeAddress: process.env.SAFE_ADDRESS!,
      ssvContract: process.env.SSV_CONTRACT!,
      operatorIds: [1, 2, 3, 4],
      chunkSize: 2,
      keystoreDir: dir,
      files,
      totalKeys: 2,
    });

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId,
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash,
          totalKeys: 2,
          initialOwnerNonce: 10,
          nextIndex: 0,
          lastKnownOwnerNonce: 10,
          batches: [
            {
              startIndex: 0,
              count: 2,
              nonce: 10,
              status: "prepared",
              updatedAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    sdkMock.api.getOwnerNonce.mockResolvedValue(11);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Owner nonce advanced by 1 keys outside tracked batches",
    );
    expect(transactionMock.createApprovedMultiSigTx).not.toHaveBeenCalled();
  });

  it("strictly reconciles pending batch when nonce confirms execution", async () => {
    const files = [
      "keystore-m_12381_3600_0_0_0-a.json",
      "keystore-m_12381_3600_1_0_0-b.json",
    ];
    const dir = await createKeystoreDir([
      { name: files[0], content: { id: "k0" } },
      { name: files[1], content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    const { runId, keystoreFilesHash } = buildRunId({
      chainId: 1,
      safeAddress: process.env.SAFE_ADDRESS!,
      ssvContract: process.env.SSV_CONTRACT!,
      operatorIds: [1, 2, 3, 4],
      chunkSize: 2,
      keystoreDir: dir,
      files,
      totalKeys: 2,
    });

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId,
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash,
          totalKeys: 2,
          initialOwnerNonce: 10,
          nextIndex: 0,
          lastKnownOwnerNonce: 10,
          batches: [
            {
              startIndex: 0,
              count: 2,
              nonce: 10,
              status: "approved",
              safeTxHash: "0xsafe",
              updatedAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    sdkMock.api.getOwnerNonce.mockResolvedValue(12);
    await runRegister("1,2,3,4", dir);

    expect(transactionMock.createApprovedMultiSigTx).not.toHaveBeenCalled();

    const progressRaw = await readFile(path.join(dir, ".ssv-register-progress.json"), "utf8");
    const progress = JSON.parse(progressRaw);
    expect(progress.nextIndex).toBe(2);
    expect(progress.lastKnownOwnerNonce).toBe(12);
    expect(progress.batches[0].status).toBe("executed");
  });

  it("fails when progress runId does not match current inputs", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId: "bad-run-id",
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash: "bad-hash",
          totalKeys: 2,
          initialOwnerNonce: 10,
          nextIndex: 0,
          lastKnownOwnerNonce: 10,
          batches: [],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Progress file runId mismatch",
    );
  });

  it("fails when progress file is invalid JSON", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await writeFile(path.join(dir, ".ssv-register-progress.json"), "{not-valid-json", "utf8");

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      /Unexpected token|JSON/i,
    );
  });

  it("rejects duplicate operator IDs", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,1,2", dir)).rejects.toThrow(
      "Operator IDs must not contain duplicates",
    );
    expect(sdkMock.api.getOperators).not.toHaveBeenCalled();
  });

  it("rejects malformed operator list", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,,3", dir)).rejects.toThrow(
      "Operator IDs must be positive integers",
    );
    expect(sdkMock.api.getOperators).not.toHaveBeenCalled();
  });

  it("rejects invalid CHUNK_SIZE values", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    process.env.CHUNK_SIZE = "0";
    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "CHUNK_SIZE must be a positive integer",
    );

    process.env.CHUNK_SIZE = "abc";
    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "CHUNK_SIZE must be a positive integer",
    );
  });

  it("handles CHUNK_SIZE=1 and processes one key per transaction", async () => {
    process.env.CHUNK_SIZE = "1";
    sdkMock.api.getOwnerNonce
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);

    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(3);
    const keyshareCalls = sdkMock.utils.generateKeyShares.mock.calls;
    expect(keyshareCalls[0][0].keystore).toHaveLength(1);
    expect(keyshareCalls[1][0].keystore).toHaveLength(1);
    expect(keyshareCalls[2][0].keystore).toHaveLength(1);
  });

  it("caps large CHUNK_SIZE to remaining keys", async () => {
    process.env.CHUNK_SIZE = "999";
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(1);
    expect(sdkMock.utils.generateKeyShares.mock.calls[0][0].keystore).toHaveLength(2);
  });

  it("retries nonce polling and succeeds when nonce catches up", async () => {
    sdkMock.api.getOwnerNonce
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
      { name: "keystore-m_12381_3600_3_0_0-d.json", content: { id: "k3" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(2);
    expect(sdkMock.api.getOwnerNonce).toHaveBeenCalledTimes(3);
  });

  it("fails when nonce polling retries are exhausted", async () => {
    sdkMock.api.getOwnerNonce
      .mockResolvedValueOnce(10)
      .mockResolvedValue(11);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
      { name: "keystore-m_12381_3600_3_0_0-d.json", content: { id: "k3" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Nonce has not been updated since last successful transaction",
    );
    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(1);
  }, 20000);

  it("persists prepared state when createApprovedMultiSigTx fails", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    transactionMock.createApprovedMultiSigTx.mockRejectedValueOnce(
      new Error("create-approved-failed"),
    );

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow("create-approved-failed");

    const progressRaw = await readFile(path.join(dir, ".ssv-register-progress.json"), "utf8");
    const progress = JSON.parse(progressRaw);
    expect(progress.batches).toHaveLength(1);
    expect(progress.batches[0].status).toBe("prepared");
  });

  it("persists approved state when execute step fails", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    transactionMock.checkAndExecuteSignatures.mockRejectedValueOnce(
      new Error("execute-failed"),
    );

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow("execute-failed");

    const progressRaw = await readFile(path.join(dir, ".ssv-register-progress.json"), "utf8");
    const progress = JSON.parse(progressRaw);
    expect(progress.batches).toHaveLength(1);
    expect(progress.batches[0].status).toBe("approved");
    expect(progress.batches[0].safeTxHash).toBe("0xsafehash");
  });

  it("rejects progress when checkpoint nonce is ahead of chain nonce", async () => {
    const files = [
      "keystore-m_12381_3600_0_0_0-a.json",
      "keystore-m_12381_3600_1_0_0-b.json",
    ];
    const dir = await createKeystoreDir([
      { name: files[0], content: { id: "k0" } },
      { name: files[1], content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    const { runId, keystoreFilesHash } = buildRunId({
      chainId: 1,
      safeAddress: process.env.SAFE_ADDRESS!,
      ssvContract: process.env.SSV_CONTRACT!,
      operatorIds: [1, 2, 3, 4],
      chunkSize: 2,
      keystoreDir: dir,
      files,
      totalKeys: 2,
    });

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId,
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash,
          totalKeys: 2,
          initialOwnerNonce: 10,
          nextIndex: 2,
          lastKnownOwnerNonce: 12,
          batches: [],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    sdkMock.api.getOwnerNonce.mockResolvedValue(11);
    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "is lower than checkpoint nonce",
    );
  });

  it("rejects when keystore file list changed from previous run", async () => {
    const files = [
      "keystore-m_12381_3600_0_0_0-a.json",
      "keystore-m_12381_3600_1_0_0-b.json",
    ];
    const dir = await createKeystoreDir([
      { name: files[0], content: { id: "k0" } },
      { name: files[1], content: { id: "k1" } },
    ]);
    tempDirs.push(dir);

    const { runId, keystoreFilesHash } = buildRunId({
      chainId: 1,
      safeAddress: process.env.SAFE_ADDRESS!,
      ssvContract: process.env.SSV_CONTRACT!,
      operatorIds: [1, 2, 3, 4],
      chunkSize: 2,
      keystoreDir: dir,
      files,
      totalKeys: 2,
    });

    await writeFile(
      path.join(dir, ".ssv-register-progress.json"),
      JSON.stringify(
        {
          version: 1,
          runId,
          chainId: 1,
          safeAddress: process.env.SAFE_ADDRESS,
          ssvContract: process.env.SSV_CONTRACT,
          operatorIds: [1, 2, 3, 4],
          chunkSize: 2,
          keystoreDir: dir,
          keystoreFilesHash,
          totalKeys: 2,
          initialOwnerNonce: 10,
          nextIndex: 0,
          lastKnownOwnerNonce: 10,
          batches: [],
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    await writeFile(
      path.join(dir, "keystore-m_12381_3600_2_0_0-c.json"),
      JSON.stringify({ id: "k2" }),
      "utf8",
    );

    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Progress file runId mismatch",
    );
  });

  it("ignores non-keystore files in the keystore directory", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "notes.txt", content: { id: "ignore" } },
      { name: "deposit_data-1.json", content: { id: "ignore" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    expect(sdkMock.utils.generateKeyShares.mock.calls[0][0].keystore).toEqual([
      JSON.stringify({ id: "k0" }),
    ]);
  });

  it("fails with clear message when a keystore JSON is invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ssv-multisig-test-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "keystore-m_12381_3600_0_0_0-a.json"),
      "{invalid-json",
      "utf8",
    );

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Failed to load keystore",
    );
  });

  it("uses deterministic fallback ordering for mixed filename formats", async () => {
    process.env.CHUNK_SIZE = "40";
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-z.json", content: { id: "z" } },
      { name: "keystore-a.json", content: { id: "a" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
      { name: "keystore-m_12381_3600_0_0_0-b.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    const keystores = sdkMock.utils.generateKeyShares.mock.calls[0][0].keystore;
    expect(keystores).toEqual([
      JSON.stringify({ id: "a" }),
      JSON.stringify({ id: "k0" }),
      JSON.stringify({ id: "k2" }),
      JSON.stringify({ id: "z" }),
    ]);
  });

  it("uses hoodi chain when TESTNET is set", async () => {
    process.env.TESTNET = "1";
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    expect(viemMock.createPublicClient).toHaveBeenCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 560048 }) }),
    );
  });

  it("limits registrations to available validator cap", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    process.env.CHUNK_SIZE = "10";
    sdkMock.api.getOperators.mockResolvedValue([
      { id: "1", validatorCount: "2999", publicKey: "op-1" },
      { id: "2", validatorCount: "20", publicKey: "op-2" },
      { id: "3", validatorCount: "30", publicKey: "op-3" },
      { id: "4", validatorCount: "40", publicKey: "op-4" },
    ]);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
      { name: "keystore-m_12381_3600_2_0_0-c.json", content: { id: "k2" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    expect(transactionMock.createApprovedMultiSigTx).toHaveBeenCalledTimes(1);
    expect(sdkMock.utils.generateKeyShares.mock.calls[0][0].keystore).toHaveLength(1);
  });

  it("exits early when an operator is already at max validators", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    sdkMock.api.getOperators.mockResolvedValue([
      { id: "1", validatorCount: "3000", publicKey: "op-1" },
      { id: "2", validatorCount: "20", publicKey: "op-2" },
      { id: "3", validatorCount: "30", publicKey: "op-3" },
      { id: "4", validatorCount: "40", publicKey: "op-4" },
    ]);

    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process-exit");
      }) as never);

    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(transactionMock.createApprovedMultiSigTx).not.toHaveBeenCalled();
  });

  it("does not leave progress temp files after successful run", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await runRegister("1,2,3,4", dir);
    const files = await readdir(dir);
    expect(files.some((file) => file.endsWith(".ssv-register-progress.json.tmp"))).toBe(false);
  });

  it("surfaces rename failures while writing progress atomically", async () => {
    sdkMock.api.getOwnerNonce.mockResolvedValue(10);
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
    ]);
    tempDirs.push(dir);

    await expect(runRegisterWithRenameFailure("1,2,3,4", dir)).rejects.toThrow(
      "rename-failed",
    );
  });

  it("fails when progress JSON is missing required run fields", async () => {
    const dir = await createKeystoreDir([
      { name: "keystore-m_12381_3600_0_0_0-a.json", content: { id: "k0" } },
      { name: "keystore-m_12381_3600_1_0_0-b.json", content: { id: "k1" } },
    ]);
    tempDirs.push(dir);
    await writeFile(path.join(dir, ".ssv-register-progress.json"), JSON.stringify({}), "utf8");

    await expect(runRegister("1,2,3,4", dir)).rejects.toThrow(
      "Progress file runId mismatch",
    );
  });
});
