/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from "commander";
import { SSVSDK, chains } from "@ssv-labs/ssv-sdk";
import { parseEther, createPublicClient, createWalletClient, http } from "viem";
import * as fs from "fs";
import { privateKeyToAccount } from "viem/accounts";
import { createValidatorKeys, ValidatorKeys } from "./generate.js";
import { checkAndExecuteSignatures, createApprovedMultiSigTx, getSafeProtocolKit } from "./transaction.js";

export const etherfi = new Command("etherfi");

const MAX_VALIDATORS_PER_OPERATOR = 1000;

etherfi
  .version("0.0.2", "-v, --vers", "output the current version")
  .argument(
    "<operators>",
    "comma separated list of ids of operators to test",
    commaSeparatedList
  )
  .option("-n, --num-keys <num-keys>", "number of keys to generate")
  .action(async (operators, _options) => {
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.OWNER_ADDRESS) throw Error("No Owner address provided");
    if (!process.env.KEYSTORES_OUTPUT_DIRECTORY)
      throw Error("Keystores output directory not provided");
    if (!process.env.KEYSTORE_PASSWORD)
      throw Error("Keystore password not provided");

    let numKeys = parseInt(_options.numKeys) || MAX_VALIDATORS_PER_OPERATOR;
    const chunkSize = parseInt(process.env.CHUNK_SIZE || "40");

    const operatorIds = operators.map((item: string) => parseInt(item));

    const private_key = process.env.PRIVATE_KEY as `0x${string}`;
    const chain = chains.hoodi;
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

    const operatorsData = (
      await sdk.api.getOperators({
        operatorIds: operatorIds,
      })
    ).sort((a, b) => Number(a.id) - Number(b.id));

    // find the operator with the maximum number of validators, and the value itself
    const maxVcountOperator = operatorsData.reduce(function (prev, current) {
      return prev && prev.validatorCount > current.validatorCount
        ? prev
        : current;
    });

    if (
      parseInt(maxVcountOperator.validatorCount) + numKeys >
      MAX_VALIDATORS_PER_OPERATOR
    ) {
      // identify what is the maximum number of keys that can be registered
      numKeys =
        MAX_VALIDATORS_PER_OPERATOR -
        parseInt(maxVcountOperator.validatorCount);

      console.info(
        `Operator ${maxVcountOperator.id} has ${maxVcountOperator.validatorCount} validators.\nGoing to only generate ${numKeys} total keys to register.`
      );
    }

    let totalKeysCreated = 0;

    while (totalKeysCreated < numKeys) {
      // generate the maximum number of keys that can be registered in a single transaction
      const keys = await createValidatorKeys({
        count: chunkSize,
        withdrawal: process.env.OWNER_ADDRESS as `0x${string}`,
        password: process.env.KEYSTORE_PASSWORD,
      });

      // write the keys to respective seed phrase file, deposit file and various keystores files
      writeKeysToFiles(keys, process.env.KEYSTORES_OUTPUT_DIRECTORY);

      // get the user nonce
      const nonce = Number(
        await sdk.api.getOwnerNonce({ owner: process.env.OWNER_ADDRESS })
      );

      console.log("Initial nonce: ", nonce);

      // split keys into keyshares
      const keysharesPayloads = await sdk.utils.generateKeyShares({
        keystore: JSON.stringify(keys.keystores),
        keystore_password: process.env.KEYSTORE_PASSWORD,
        operator_keys: operatorsData.map((operator) => operator.publicKey),
        operator_ids: operatorsData.map((operator) => Number(operator.id)),
        owner_address: process.env.OWNER_ADDRESS,
        nonce: nonce,
      });

      // generate the transaction
      const tx_data = await sdk.clusters
      .registerValidators({
        args: {
          keyshares: keysharesPayloads,
          depositAmount: parseEther("30"),
        },
      })
      // generate Safe TX
      const multiSigTransaction = await createApprovedMultiSigTx(safeProtocolKit, tx_data)
      await checkAndExecuteSignatures(safeProtocolKit, multiSigTransaction);

      totalKeysCreated += chunkSize;
    }
  });

function writeKeysToFiles(keys: ValidatorKeys, outputPath: string): void {
  // write seed phrase
  fs.writeFile(
    `${outputPath}/master-${keys.masterSKHash}`,
    keys.masterSK,
    (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Operators saved to file: ${outputPath}`);
      }
    }
  );

  // write deposit file
  fs.writeFile(
    `${outputPath}/deposit_data-${keys.masterSKHash}`,
    keys.masterSK,
    (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Operators saved to file: ${outputPath}`);
      }
    }
  );

  // write keyshares
  for (const [i, keyshare] of keys.keystores.entries()) {
    const KEYSTORE_FILEPATH_TEMPLATE = `${outputPath}/keystore-m_12381_3600_${i}_0_0`;

    const keyshareString = JSON.stringify(keyshare);
    // Save the error message to a local file
    fs.writeFile(KEYSTORE_FILEPATH_TEMPLATE, keyshareString, (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Operators saved to file: ${outputPath}`);
      }
    });
  }
}

function commaSeparatedList(value: string, _dummyPrevious: unknown) {
  return value.split(",");
}
