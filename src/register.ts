/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from "commander";
import { SSVSDK, chains } from "@ssv-labs/ssv-sdk";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createValidatorKeys } from "./generate.js";
import { checkAndExecuteSignatures, createApprovedMultiSigTx, getSafeProtocolKit } from "./transaction.js";
import { ClusterSnapshot, getClusterSnapshot } from "./subgraph.js";
import { commaSeparatedList, getBulkRegistrationTxData, retryWithExponentialBackoff, ShareObject, writeKeysToFiles } from "./utils.js";
import { ethers } from "ethers";

import * as dotenv from "dotenv";
dotenv.config();

export const register = new Command("register");

const MAX_VALIDATORS_PER_OPERATOR = 1000;
const KEYSTORES_OUTPUT_DIRECTORY = "./validator_keys"

register
  .version("0.0.2", "-v, --vers", "output the current version")
  .argument(
    "<operatorIds>",
    "comma separated list of ids of operators to test",
    commaSeparatedList
  )
  .option("-n, --num-keys <num-keys>", "number of keys to generate")
  .action(async (operatorIds, _options) => {
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.SSV_CONTRACT) throw Error("No SSV contract address provided");
    if (!process.env.OWNER_ADDRESS) throw Error("No Owner address provided");
    if (!process.env.KEYSTORE_PASSWORD)
      throw Error("Keystore password not provided");
    
    console.log(`Registering keyshares to operators: ${JSON.stringify(operatorIds)}`)

    const private_key = process.env.PRIVATE_KEY as `0x${string}`;
    let keysCount = parseInt(_options.numKeys) || MAX_VALIDATORS_PER_OPERATOR;
    console.log(`Requested creation of ${keysCount} keys.`)

    const chunkSize = parseInt(process.env.CHUNK_SIZE || "40");
    console.log(`Maximum number of keys per transaction: ${chunkSize}.`)

    // const chain = process.env.TESTNET? chains.hoodi : chains.mainnet
    const chain = process.env.TESTNET? chains.holesky : chains.mainnet
    console.log(`Using chain with ID: ${chain.id}`)

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
    });

    const safeProtocolKit = await getSafeProtocolKit(
        process.env.RPC_ENDPOINT,
        process.env.PRIVATE_KEY,
        process.env.SAFE_ADDRESS,
    )

    console.log(`Collecting operator data...`)
    const operatorsData = (
      await sdk.api.getOperators({
        operatorIds: operatorIds.map((id: number) => `${id}`),
      })
    ).sort((a, b) => Number(a.id) - Number(b.id));

    // Log validator counts for each operator
    console.log("\nOperator validator counts:");
    operatorsData.forEach(operator => {
      console.log(`Operator ${operator.id}: ${operator.validatorCount} validators`);
    });
    console.log("");

    // Check if any operator has reached the maximum limit
    const maxedOperator = operatorsData.find(operator => parseInt(operator.validatorCount) >= MAX_VALIDATORS_PER_OPERATOR);
    if (maxedOperator) {
      console.log(`Operator ${maxedOperator.id} has reached the maximum limit of ${MAX_VALIDATORS_PER_OPERATOR} validators. Exiting...`);
      process.exit(0);
    }

    // find the operator with the maximum number of validators, and the value itself
    const maxVcountOperator = operatorsData.reduce(function (prev, current) {
      return prev && prev.validatorCount > current.validatorCount
        ? prev
        : current;
    });
    console.log(`Operator with the most validators registered to it has ${maxVcountOperator.validatorCount} keys`)

    if (parseInt(maxVcountOperator.validatorCount) >= MAX_VALIDATORS_PER_OPERATOR) {
      console.log("Maximum validator limit (1000) has been reached for at least one operator. Exiting...");
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
        `Operator ${maxVcountOperator.id} has ${maxVcountOperator.validatorCount} validators.\nGoing to only generate ${keysCount} total keys to register.`
      );
    }

    // need to initialize these
    let totalKeysRegistered = 0;
    let nonce = Number(await sdk.api.getOwnerNonce({ owner: process.env.OWNER_ADDRESS }));
    let expectedNonce = nonce;

    while (totalKeysRegistered < keysCount) {
      // Calculate how many keys we can register in this batch
      const remainingKeys = keysCount - totalKeysRegistered;
      const currentChunkSize = Math.min(chunkSize, remainingKeys);
      
      // generate the keys for this batch
      console.log(`Creating keystores (${currentChunkSize} keys)`)
      const keys = await createValidatorKeys({
        count: currentChunkSize,
        withdrawal: process.env.OWNER_ADDRESS as `0x${string}`,
        password: process.env.KEYSTORE_PASSWORD,
      });
      
      console.log(`Keystores created.`)

      // get the user nonce for batch 1 onwards
      if (totalKeysRegistered != 0 ) {
        nonce = await retryWithExponentialBackoff(verifyUpdatedNonce, {sdk, nonce, expectedNonce, ownerAddress: process.env.SAFE_ADDRESS}, {
          retries: 3,
          factor: 2,
          maxTimeout: 10000,
          maxRetryTime: 5000,
        })
      }
      
      console.log("Current nonce: ", nonce);
      
      // split keys into keyshares
      const keysharesPayloads = await sdk.utils.generateKeyShares({
        keystore: keys.keystores.map((keystore) => JSON.stringify(keystore)),
        keystore_password: process.env.KEYSTORE_PASSWORD,
        operator_keys: operatorsData.map((operator) => operator.publicKey),
        operator_ids: operatorsData.map((operator) => Number(operator.id)),
        owner_address: process.env.OWNER_ADDRESS,
        nonce: nonce,
      });
      
      // write the keys to respective seed phrase file, deposit file and various keystores files
      writeKeysToFiles(keys, keysharesPayloads, KEYSTORES_OUTPUT_DIRECTORY);

      // Transform keysharesPayloads into ShareObject type
      const shareObjects: ShareObject[] = keysharesPayloads.map((payload: any) => ({
        keySharesFilePath: `${KEYSTORES_OUTPUT_DIRECTORY}/keyshares-${keys.masterSKHash}.json`,
        data: {
          ownerNonce: nonce,
          ownerAddress: process.env.OWNER_ADDRESS!,
          publicKey: payload.publicKey,
          operators: [{
            id: Number(operatorsData[0].id),
            operatorKey: operatorsData[0].publicKey
          }]
        },
        payload: {
          publicKey: payload.publicKey,
          operatorIds: operatorsData.map((operator) => Number(operator.id)),
          sharesData: payload.sharesData
        }
      }));

      let clusterSnapshot = await getClusterSnapshot(process.env.OWNER_ADDRESS, operatorIds)

      const ethersWallet = new ethers.Wallet(private_key, new ethers.JsonRpcProvider(process.env.RPC_ENDPOINT));
      
      let txData = await getBulkRegistrationTxData(shareObjects, process.env.OWNER_ADDRESS, ethersWallet, clusterSnapshot)

      // generate Safe TX
      const multiSigTransaction = await createApprovedMultiSigTx(safeProtocolKit, txData)
      await checkAndExecuteSignatures(safeProtocolKit, multiSigTransaction);

      totalKeysRegistered += currentChunkSize;
      expectedNonce = nonce + currentChunkSize;
    }
  });

  async function verifyUpdatedNonce(options: {sdk: SSVSDK, nonce:number, expectedNonce: number, ownerAddress: string}) {
    var {sdk, nonce, expectedNonce, ownerAddress} = options
    // update nonce
    console.info(`Obtaining owner nonce`);
    nonce = Number(await sdk.api.getOwnerNonce({ owner: ownerAddress }));
    console.info(`Owner nonce: ${nonce}`);
    // expected to be the same on first loop, but important on following ones
    if (nonce !== expectedNonce) {
      console.error(
        "Nonce has not been updated since last successful transaction, retrying"
      );
      throw Error("Nonce has not been updated since last successful transaction! Exiting")
    }

    return nonce
  }