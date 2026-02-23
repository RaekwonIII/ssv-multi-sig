/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from "commander";
import { SSVSDK, chains } from "@ssv-labs/ssv-sdk";
import { createClusterId } from '@ssv-labs/ssv-sdk/utils'
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
  getBulkRegistrationTxData,
  retryWithExponentialBackoff,
  writeKeysToFiles,
} from "./utils.js";
import { ethers } from "ethers";

import * as dotenv from "dotenv";
import { readdir, readFile } from "fs/promises";
dotenv.config();

export const register = new Command("register");

const MAX_VALIDATORS_PER_OPERATOR = 3000;
const KEYSTORES_OUTPUT_DIRECTORY = "./validator_keys";

register
  .version("0.0.2", "-v, --vers", "output the current version")
  .argument(
    "<operatorIds>",
    "comma separated list of ids of operators to test",
    commaSeparatedList,
  )
  .option("-n, --num-keys <num-keys>", "number of keys to generate")
  .option("-k, --keystoresDir <keystores-dir>", "keystores output directory")
  .action(async (operatorIds, _options) => {
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.SSV_CONTRACT)
      throw Error("No SSV contract address provided");
    if (!process.env.SUBGRAPH_API)
      throw Error("No Subgraph API endpoint provided");
    if (!process.env.SUBGRAPH_API_KEY)
      throw Error("No Subgraph API Key provided");
    if (!process.env.KEYSTORE_PASSWORD)
      throw Error("Keystore password not provided");

    console.log(
      `Registering keyshares to operators: ${JSON.stringify(operatorIds)}`,
    );

    const private_key = process.env.PRIVATE_KEY as `0x${string}`;
    let generateKeystores = false;
    let keystoresDir = _options.keystoresDir;
    let loadedKeystores = [];
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
      loadedKeystores = await loadKeystores(keystoresDir);
      keysCount = loadedKeystores.length;
      console.log(`Loaded ${keysCount} keystore files.`);
    }

    const chunkSize = parseInt(process.env.CHUNK_SIZE || "40");
    console.log(`Maximum number of keys per transaction: ${chunkSize}.`);

    const chain = process.env.TESTNET ? chains.hoodi : chains.mainnet;
    console.log(`Using chain with ID: ${chain.id}`);

    const transport = http();
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
      return prev && prev.validatorCount > current.validatorCount
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
        "Maximum validator limit (1000) has been reached for at least one operator. Exiting...",
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
      await sdk.api.getOwnerNonce({ owner: process.env.SAFE_ADDRESS }),
    );
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
          withdrawal: process.env.SAFE_ADDRESS as `0x${string}`,
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
      // get the user nonce for batch 1 onwards
      if (totalKeysRegistered != 0) {
        nonce = await retryWithExponentialBackoff(
          verifyUpdatedNonce,
          { sdk, nonce, expectedNonce, ownerAddress: process.env.SAFE_ADDRESS },
          {
            retries: 3,
            factor: 2,
            maxTimeout: 10000,
            maxRetryTime: 5000,
          },
        );
      }

      console.log("Current nonce: ", nonce);

      // split keys into keyshares
      const keyshares = await sdk.utils.generateKeyShares({
        keystore: keysToRegister.map((keystore) => JSON.stringify(keystore)),
        keystore_password: process.env.KEYSTORE_PASSWORD,
        operator_keys: operatorsData.map((operator) => operator.publicKey),
        operator_ids: operatorsData.map((operator) => Number(operator.id)),
        owner_address: process.env.SAFE_ADDRESS,
        nonce: nonce,
      });
        
      let txData = await sdk.clusters.registerValidatorsRawData({args: {keyshares, depositAmount: parseEther("0.1")}})

      // generate Safe TX
      const multiSigTransaction = await createApprovedMultiSigTx(
        safeProtocolKit,
        txData,
      );
      await checkAndExecuteSignatures(safeProtocolKit, multiSigTransaction);

      if (generateKeystores) {
        // only write to file if the tx has succeeded, to avoid confusion in case of failed tx
        // write the keys to respective seed phrase file, deposit file and various keystores files
        writeKeysToFiles(
          generatedKeystores,
          keyshares,
          KEYSTORES_OUTPUT_DIRECTORY,
        );
      }
      totalKeysRegistered += currentChunkSize;
      expectedNonce = nonce + currentChunkSize;
      console.log(
        `Successfully registered ${totalKeysRegistered} keys so far. Last registered pubkey is ${keyshares[keyshares.length - 1].publicKey}. Moving on to the next batch...`,
      );
    }
  });

async function loadKeystores(keystoreDir: string): Promise<any[]> {
  try {
    const files = await readdir(keystoreDir);
    const keys = [];
    for (const file of files) {
      if (file.startsWith("keystore")) {
        const content = await readFile(`${keystoreDir}/${file}`, {
          encoding: "utf8",
        });
        keys.push(JSON.parse(content));
      }
    }
    return keys;
  } catch (error) {
    console.error("Failed to read keystore JSON file:", error);
    throw new Error(
      "Failed to load keystore. Please check keystore JSON file exists and is valid.",
    );
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
