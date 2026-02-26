/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from "commander";
import { SSVSDK, chains } from "@ssv-labs/ssv-sdk";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createValidatorKeys, ValidatorKeys } from "./generate.js";
import {
  checkAndExecuteSignatures,
  createApprovedMultiSigTx,
  getSafeProtocolKit,
} from "./transaction.js";
import {
  commaSeparatedList,
  getRegistrationTxDataV2,
  retryWithExponentialBackoff,
  writeKeysToFiles,
} from "./utils.js";

import * as dotenv from "dotenv";
import { readdir, readFile, writeFile, rename, access } from "fs/promises";
import { createHash } from "crypto";
dotenv.config();

export const register = new Command("register");

const MAX_VALIDATORS_PER_OPERATOR = 3000;
const KEYSTORES_OUTPUT_DIRECTORY = "./validator_keys";
const PROGRESS_FILENAME = ".ssv-register-progress.json";

type BatchStatus = "prepared" | "approved" | "executed";

type ProgressBatch = {
  startIndex: number;
  count: number;
  nonce: number;
  status: BatchStatus;
  safeTxHash?: string;
  executeTxHash?: string;
  receiptBlock?: number;
  updatedAt: string;
};

type ProgressState = {
  version: 1;
  runId: string;
  chainId: number;
  safeAddress: string;
  ssvContract: string;
  operatorIds: number[];
  chunkSize: number;
  keystoreDir: string;
  keystoreFilesHash: string;
  totalKeys: number;
  initialOwnerNonce: number;
  nextIndex: number;
  lastKnownOwnerNonce: number;
  batches: ProgressBatch[];
  updatedAt: string;
};

register
  .version("0.0.2", "-v, --vers", "output the current version")
  .argument(
    "<operatorIds>",
    "comma separated list of ids of operators to test",
    commaSeparatedList,
  )
  .option("-n, --num-keys <num-keys>", "number of keys to generate")
  .option(
    "-k, --keystoresDir <keystores-dir>",
    "directory to load existing keystores from",
  )
  .action(async (operatorIds, _options) => {
    if (!Array.isArray(operatorIds) || operatorIds.length === 0) {
      throw Error("At least one operator ID must be provided");
    }
    if (operatorIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw Error("Operator IDs must be positive integers");
    }
    if (new Set(operatorIds).size !== operatorIds.length) {
      throw Error("Operator IDs must not contain duplicates");
    }

    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    try {
      new URL(process.env.RPC_ENDPOINT);
    } catch {
      throw Error("RPC endpoint must be a valid URL");
    }
    if (!process.env.SUBGRAPH_API)
      throw Error("No Subgraph API endpoint provided");
    if (!process.env.SUBGRAPH_API_KEY)
      throw Error("No Subgraph API Key provided");
    if (!process.env.KEYSTORE_PASSWORD)
      throw Error("Keystore password not provided");
    const depositAmountEth = process.env.DEPOSIT_AMOUNT_ETH || "0.1";
    let depositAmount: bigint;
    try {
      depositAmount = parseEther(depositAmountEth);
    } catch {
      throw Error("DEPOSIT_AMOUNT_ETH must be a valid decimal ETH value");
    }
    const ssvContractAddress = process.env.SSV_CONTRACT as `0x${string}` | undefined;
    if (!ssvContractAddress) {
      throw Error("No SSV contract address provided");
    }
    // Hoodi/testnet ABI is payable (value carries deposit); legacy/mainnet ABI is nonpayable (deposit is in calldata).
    const safeTxValue = process.env.TESTNET ? depositAmount.toString() : "0";

    console.log(
      `Registering keyshares to operators: ${JSON.stringify(operatorIds)}`,
    );
    console.log(`Deposit amount: ${depositAmountEth} ETH (${depositAmount.toString()} wei)`);

    const private_key = process.env.PRIVATE_KEY as `0x${string}`;
    let generateKeystores = false;
    let keystoresDir = _options.keystoresDir;
    let loadedKeystores = [];
    let loadedKeystoreFiles: string[] = [];
    let keysCount;
    if (!keystoresDir) {
      keystoresDir = KEYSTORES_OUTPUT_DIRECTORY;
      generateKeystores = true;
      console.log(
        `No keystores output directory provided, generating keystore files in ${keystoresDir}`,
      );
      console.log(`Keystores output directory: ${keystoresDir}`);
      keysCount = parseInt(_options.numKeys) || MAX_VALIDATORS_PER_OPERATOR;
      console.log(`Requested creation of ${keysCount} keys.`);
    } else {
      console.log(`Loading keystores from directory: ${keystoresDir}`);
      const loaded = await loadKeystores(keystoresDir);
      loadedKeystores = loaded.keystores;
      loadedKeystoreFiles = loaded.files;
      keysCount = loadedKeystores.length;
      console.log(`Loaded ${keysCount} keystore files.`);
    }

    const chunkSize = parseInt(process.env.CHUNK_SIZE || "40", 10);
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw Error("CHUNK_SIZE must be a positive integer");
    }
    console.log(`Maximum number of keys per transaction: ${chunkSize}.`);

    const chain = process.env.TESTNET ? chains.hoodi : chains.mainnet;
    console.log(`Using chain with ID: ${chain.id}`);
    console.log(`Chain: ${chain.name}`)

    const transport = http(process.env.RPC_ENDPOINT);
    const publicClient = createPublicClient({
      chain,
      transport,
    });

    const account = privateKeyToAccount(private_key);
    const walletClient = createWalletClient({
      account,
      chain,
      transport,
    });

    const ownerAddress = process.env.SAFE_ADDRESS as `0x${string}`;

    // Initialize SDK with viem clients
    const sdk = new SSVSDK({
      walletClient: walletClient,
      publicClient: publicClient,
      extendedConfig: {
        subgraph: {
          endpoint: process.env.SUBGRAPH_API,
          apiKey: process.env.SUBGRAPH_API_KEY,
        },
        
      }
    });

    const safeProtocolKit = await getSafeProtocolKit(
          process.env.RPC_ENDPOINT,
          process.env.PRIVATE_KEY,
          process.env.SAFE_ADDRESS,
        );

    console.log(`Collecting operator data...`);
    const operatorsData = (
      await sdk.api.getOperators({
        operatorIds: operatorIds.map((id: number) => `${id}`),
      })
    ).sort((a, b) => Number(a.id) - Number(b.id));

    // Log validator counts for each operator
    console.log("\nOperator validator counts:");
    operatorsData.forEach((operator) => {
      console.log(
        `Operator ${operator.id}: ${operator.validatorCount} validators`,
      );
    });
    console.log("");

    // Check if any operator has reached the maximum limit
    const maxedOperator = operatorsData.find(
      (operator) =>
        parseInt(operator.validatorCount) >= MAX_VALIDATORS_PER_OPERATOR,
    );
    if (maxedOperator) {
      console.log(
        `Operator ${maxedOperator.id} has reached the maximum limit of ${MAX_VALIDATORS_PER_OPERATOR} validators. Exiting...`,
      );
      process.exit(0);
    }

    // find the operator with the maximum number of validators, and the value itself
    const maxVcountOperator = operatorsData.reduce(function (prev, current) {
      return prev && Number(prev.validatorCount) > Number(current.validatorCount)
        ? prev
        : current;
    });
    console.log(
      `Operator with the most validators registered to it has ${maxVcountOperator.validatorCount} keys`,
    );

    if (
      parseInt(maxVcountOperator.validatorCount) >= MAX_VALIDATORS_PER_OPERATOR
    ) {
        console.log(
          `Maximum validator limit (${MAX_VALIDATORS_PER_OPERATOR}) has been reached for at least one operator. Exiting...`,
        );
        process.exit(0);
      }

    if (
      parseInt(maxVcountOperator.validatorCount) + keysCount >
      MAX_VALIDATORS_PER_OPERATOR
    ) {
      // identify what is the maximum number of keys that can be registered
      keysCount =
        MAX_VALIDATORS_PER_OPERATOR -
        parseInt(maxVcountOperator.validatorCount);

      console.info(
        `Operator ${maxVcountOperator.id} has ${maxVcountOperator.validatorCount} validators.\nGoing to only generate ${keysCount} total keys to register.`,
      );
    }

    // need to initialize these
    let totalKeysRegistered = 0;
    let nonce = Number(
      await sdk.api.getOwnerNonce({ owner: ownerAddress }),
    );

    let progress: ProgressState | null = null;
    let progressPath: string | null = null;
    if (!generateKeystores) {
      progressPath = `${keystoresDir}/${PROGRESS_FILENAME}`;
      const runId = createRunId({
        chainId: chain.id,
        safeAddress: ownerAddress,
        ssvContract: ssvContractAddress,
        operatorIds,
        chunkSize,
        keystoreDir: keystoresDir,
        keystoreFilesHash: hashKeystoreFileList(loadedKeystoreFiles),
        totalKeys: keysCount,
      });

      progress = await loadOrCreateProgress({
        runId,
        progressPath,
        chainId: chain.id,
        safeAddress: ownerAddress,
        ssvContract: ssvContractAddress,
        operatorIds,
        chunkSize,
        keystoreDir: keystoresDir,
        keystoreFilesHash: hashKeystoreFileList(loadedKeystoreFiles),
        totalKeys: keysCount,
        ownerNonce: nonce,
      });

      progress = reconcileProgressStrict(progress, nonce);
      await saveProgress(progressPath, progress);
      totalKeysRegistered = progress.nextIndex;
      nonce = progress.lastKnownOwnerNonce;
      console.log(
        `Resume state: next key index ${totalKeysRegistered}, owner nonce ${nonce}.`,
      );
    }

    let expectedNonce = nonce;
    while (totalKeysRegistered < keysCount) {
      // Calculate how many keys we can register in this batch
      const remainingKeys = keysCount - totalKeysRegistered;
      const currentChunkSize = Math.min(chunkSize, remainingKeys);

      let keysToRegister = [];
      let generatedKeystores: ValidatorKeys = {} as ValidatorKeys;
      if (generateKeystores) {
        // generate the keys for this batch
        console.log(`Creating keystores (${currentChunkSize} keys)`);
        generatedKeystores = await createValidatorKeys({
          count: currentChunkSize,
          withdrawal: ownerAddress,
          password: process.env.KEYSTORE_PASSWORD,
        });
        keysToRegister = generatedKeystores.keystores;

        console.log(`Keystores created.`);
      } else {
        console.log(
          `Using existing keystores from directory: ${keystoresDir} for keys ${totalKeysRegistered} to ${
            totalKeysRegistered + currentChunkSize
          }`,
        );
        keysToRegister = loadedKeystores.slice(
          totalKeysRegistered,
          totalKeysRegistered + currentChunkSize,
        );
      }

      let activeBatch: ProgressBatch | null = null;
      if (progress && progressPath) {
        activeBatch = {
          startIndex: totalKeysRegistered,
          count: currentChunkSize,
          nonce,
          status: "prepared",
          updatedAt: new Date().toISOString(),
        };
        progress = upsertProgressBatch(progress, activeBatch);
        await saveProgress(progressPath, progress);
      }

      // get the user nonce for batch 1 onwards
      if (totalKeysRegistered != 0) {
        nonce = await retryWithExponentialBackoff(
          verifyUpdatedNonce,
          { sdk, nonce, expectedNonce, ownerAddress },
          {
            retries: 3,
            factor: 2,
            maxTimeout: 10000,
            maxRetryTime: 5000,
          },
        );
      }

      console.log("Current nonce: ", nonce);

      if (progress && progressPath && activeBatch && activeBatch.nonce !== nonce) {
        activeBatch.nonce = nonce;
        progress = upsertProgressBatch(progress, activeBatch);
        await saveProgress(progressPath, progress);
      }

      // split keys into keyshares
      const keyshares = await sdk.utils.generateKeyShares({
        keystore: keysToRegister.map((keystore) => JSON.stringify(keystore)),
        keystorePassword: process.env.KEYSTORE_PASSWORD,
        operatorKeys: operatorsData.map((operator) => operator.publicKey),
        operatorIds: operatorsData.map((operator) => Number(operator.id)),
        ownerAddress,
        nonce: nonce,
      });

      
        const clusterId = createClusterId(
          ownerAddress,
          operatorsData.map((operator) => Number(operator.id)),
        );
        const clusterSnapshot = await sdk.api.toSolidityCluster({ id: clusterId });
        const snapshot = clusterSnapshot ? clusterSnapshot : {
          validatorCount: 0,
          networkFeeIndex: 0n,
          index: 0n,
          balance: 0n,
          active: true,
        };
        
        const txData = getRegistrationTxDataV2(keyshares, snapshot, depositAmount);

      // generate Safe TX
      if (!safeProtocolKit) {
        throw Error("Safe protocol kit is not initialized");
      }
      const { safeTransaction: multiSigTransaction, safeTxHash } =
        await createApprovedMultiSigTx(
          safeProtocolKit,
          txData,
          ssvContractAddress,
          safeTxValue,
        );

      if (progress && progressPath && activeBatch) {
        activeBatch.status = "approved";
        activeBatch.safeTxHash = safeTxHash;
        activeBatch.updatedAt = new Date().toISOString();
        progress = upsertProgressBatch(progress, activeBatch);
        await saveProgress(progressPath, progress);
      }

      const executeTxHash = await checkAndExecuteSignatures(
        safeProtocolKit,
        multiSigTransaction,
      );

      if (generateKeystores) {
        // only write to file if the tx has succeeded, to avoid confusion in case of failed tx
        // write the keys to respective seed phrase file, deposit file and various keystores files
        writeKeysToFiles(
          generatedKeystores,
          keyshares,
          KEYSTORES_OUTPUT_DIRECTORY,
        );
      }

      if (progress && progressPath && activeBatch) {
        activeBatch.status = "executed";
        activeBatch.executeTxHash = executeTxHash;
        activeBatch.updatedAt = new Date().toISOString();
        progress = upsertProgressBatch(progress, activeBatch);
        progress.nextIndex = totalKeysRegistered + currentChunkSize;
        progress.lastKnownOwnerNonce = nonce + currentChunkSize;
        progress.updatedAt = new Date().toISOString();
        await saveProgress(progressPath, progress);
      }

      totalKeysRegistered += currentChunkSize;
      expectedNonce = nonce + currentChunkSize;
      console.log(
        `Successfully registered ${totalKeysRegistered} keys so far. Last registered pubkey is ${keyshares[keyshares.length - 1].publicKey}. Moving on to the next batch...`,
      );
    }
  });

async function loadKeystores(
  keystoreDir: string,
): Promise<{ keystores: any[]; files: string[] }> {
  try {
    const files = await readdir(keystoreDir);
    const sortedKeystoreFiles = files
      .filter((file) => file.startsWith("keystore"))
      .sort((a, b) => {
        const indexRegex = /keystore-m_12381_3600_(\d+)_0_0-/;
        const aMatch = a.match(indexRegex);
        const bMatch = b.match(indexRegex);

        if (aMatch && bMatch) {
          return Number(aMatch[1]) - Number(bMatch[1]);
        }

        return a.localeCompare(b);
      });

    const keys = [];
    for (const file of sortedKeystoreFiles) {
      const content = await readFile(`${keystoreDir}/${file}`, {
        encoding: "utf8",
      });
      keys.push(JSON.parse(content));
    }
    return { keystores: keys, files: sortedKeystoreFiles };
  } catch (error) {
    console.error("Failed to read keystore JSON file:", error);
    throw new Error(
      "Failed to load keystore. Please check keystore JSON file exists and is valid.",
    );
  }
}

function hashKeystoreFileList(files: string[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function createRunId(options: {
  chainId: number;
  safeAddress: string;
  ssvContract: string;
  operatorIds: number[];
  chunkSize: number;
  keystoreDir: string;
  keystoreFilesHash: string;
  totalKeys: number;
}): string {
  const payload = {
    chainId: options.chainId,
    safeAddress: options.safeAddress.toLowerCase(),
    ssvContract: options.ssvContract.toLowerCase(),
    operatorIds: [...options.operatorIds].sort((a, b) => a - b),
    chunkSize: options.chunkSize,
    keystoreDir: options.keystoreDir,
    keystoreFilesHash: options.keystoreFilesHash,
    totalKeys: options.totalKeys,
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function loadOrCreateProgress(options: {
  runId: string;
  progressPath: string;
  chainId: number;
  safeAddress: string;
  ssvContract: string;
  operatorIds: number[];
  chunkSize: number;
  keystoreDir: string;
  keystoreFilesHash: string;
  totalKeys: number;
  ownerNonce: number;
}): Promise<ProgressState> {
  const exists = await fileExists(options.progressPath);
  if (!exists) {
    const freshProgress: ProgressState = {
      version: 1,
      runId: options.runId,
      chainId: options.chainId,
      safeAddress: options.safeAddress,
      ssvContract: options.ssvContract,
      operatorIds: [...options.operatorIds].sort((a, b) => a - b),
      chunkSize: options.chunkSize,
      keystoreDir: options.keystoreDir,
      keystoreFilesHash: options.keystoreFilesHash,
      totalKeys: options.totalKeys,
      initialOwnerNonce: options.ownerNonce,
      nextIndex: 0,
      lastKnownOwnerNonce: options.ownerNonce,
      batches: [],
      updatedAt: new Date().toISOString(),
    };

    await saveProgress(options.progressPath, freshProgress);
    return freshProgress;
  }

  const raw = await readFile(options.progressPath, { encoding: "utf8" });
  const existing = JSON.parse(raw) as ProgressState;

  if (existing.runId !== options.runId) {
    throw new Error(
      `Progress file runId mismatch. Provided parameters do not match existing progress at ${options.progressPath}.`,
    );
  }

  return existing;
}

function reconcileProgressStrict(
  progress: ProgressState,
  currentOwnerNonce: number,
): ProgressState {
  if (currentOwnerNonce < progress.lastKnownOwnerNonce) {
    throw new Error(
      `Current owner nonce (${currentOwnerNonce}) is lower than checkpoint nonce (${progress.lastKnownOwnerNonce}). Aborting in strict resume mode.`,
    );
  }

  const totalDelta = currentOwnerNonce - progress.lastKnownOwnerNonce;
  let nonceDelta = totalDelta;
  if (nonceDelta === 0) return progress;

  const pendingBatches = progress.batches
    .filter((batch) => batch.status !== "executed")
    .sort((a, b) => a.startIndex - b.startIndex);

  for (const batch of pendingBatches) {
    if (nonceDelta < batch.count) break;

    batch.status = "executed";
    batch.updatedAt = new Date().toISOString();
    progress.nextIndex = Math.max(progress.nextIndex, batch.startIndex + batch.count);
    progress.lastKnownOwnerNonce += batch.count;
    nonceDelta -= batch.count;
  }

  if (nonceDelta !== 0) {
    throw new Error(
      `Owner nonce advanced by ${totalDelta} keys outside tracked batches. Aborting in strict resume mode.`,
    );
  }

  progress.updatedAt = new Date().toISOString();
  return progress;
}

function upsertProgressBatch(
  progress: ProgressState,
  batch: ProgressBatch,
): ProgressState {
  const idx = progress.batches.findIndex(
    (item) =>
      item.startIndex === batch.startIndex &&
      item.count === batch.count &&
      item.nonce === batch.nonce,
  );

  if (idx === -1) {
    progress.batches.push(batch);
  } else {
    progress.batches[idx] = {
      ...progress.batches[idx],
      ...batch,
      updatedAt: new Date().toISOString(),
    };
  }

  progress.updatedAt = new Date().toISOString();
  return progress;
}

async function saveProgress(progressPath: string, progress: ProgressState) {
  const tmpPath = `${progressPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(progress, null, 2), {
    encoding: "utf8",
  });
  await rename(tmpPath, progressPath);
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyUpdatedNonce(options: {
  sdk: SSVSDK;
  nonce: number;
  expectedNonce: number;
  ownerAddress: string;
}) {
  var { sdk, nonce, expectedNonce, ownerAddress } = options;
  // update nonce
  console.info(`Obtaining owner nonce`);
  nonce = Number(await sdk.api.getOwnerNonce({ owner: ownerAddress }));
  console.info(`Owner nonce: ${nonce}`);
  // expected to be the same on first loop, but important on following ones
  if (nonce !== expectedNonce) {
    console.error(
      "Nonce has not been updated since last successful transaction, retrying",
    );
    throw Error(
      "Nonce has not been updated since last successful transaction! Exiting",
    );
  }

  return nonce;
}

function createClusterId(ownerAddress: string, operatorIds: number[]) {
  return `${ownerAddress.toLowerCase()}-${operatorIds.join("-")}`;
}
