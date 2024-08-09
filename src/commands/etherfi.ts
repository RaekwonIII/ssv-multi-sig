import { Command } from "commander";
import figlet from "figlet";

import { chunks, getKeyshareObjects, debug } from "../utils";
import { areKeysharesValid } from "../ssv-keys";
import {
  getOwnerNonceFromSubgraph,
  getRegisteredPubkeys,
  getValidatorCountPerOperator,
} from "../subgraph";
import {
  checkAndExecuteSignatures,
  createApprovedMultiSigTx,
  getSignerandAdapter,
  getBulkRegistrationTxData,
} from "../transaction";

export const etherfi = new Command("etherfi");

console.debug = debug

etherfi
  .version("0.0.1", "-v, --vers", "output the current version")
  .argument(
    "<directory>",
    "The path to the directory containing keyshare files"
  )
  .action(async (directory, options) => {
    console.info(figlet.textSync("SSV <> EtherFi"));
    console.info(
      "Automating registration of multiple validators for a Safe multisig wallet."
    );
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    let chunkSize = parseInt(process.env.CHUNK_SIZE || "40");
    let problems = new Map();

    console.info("Extracting keyshares from files in provided folder");

    let keyshares = await getKeyshareObjects(directory);
    console.info(`Done. Found ${keyshares.length} total keyshares`);

    let operatorIds = new Set<number>();
    // add operatorIds from the keyshares object to the operatorIds set
    keyshares.map((item) =>
      item.payload.operatorIds.map((operatorId) => operatorIds.add(operatorId))
    );

    // get the validators count for each operator
    let validatorsCountPerOperator = await getValidatorCountPerOperator(
      Array.from(operatorIds)
    );

    // find the operator with the maximum number of validators, and the value itself
    const maxVcountOperator = validatorsCountPerOperator.reduce(
      function (prev, current) {
        return prev && prev.validatorCount > current.validatorCount
          ? prev
          : current;
      }
    );

    if (maxVcountOperator.validatorCount + keyshares.length > 500) {
      // identify the item in the list that's going to be the last one
      let lastKeysharesIndex = 500 - maxVcountOperator.validatorCount;
      let lastKeyshareObj = keyshares.at(lastKeysharesIndex);
      console.error(`Operator ${maxVcountOperator.id} has ${maxVcountOperator.validatorCount} validators.`);
      console.error(`Pubkey ${lastKeyshareObj?.payload.publicKey} is going to cause operators to reach maximum validators.`);
      console.error(`Going to only include files up to ${lastKeyshareObj?.keySharesFilePath} and only public keys preceding this one.`);
      // splice the array, effectively reducing it to the correct number
      keyshares.splice(lastKeysharesIndex);
    }

    console.info(`Fetching registered public keys`);
    // find public keys that were already registered
    let registeredPubkeys = await getRegisteredPubkeys(
      keyshares.map((item) => item.data.publicKey)
    );

    // remove them from the keyshares list
    keyshares = keyshares.filter(
      (item) => !registeredPubkeys.includes(item.data.publicKey)
    );
    console.info(
      `Found ${registeredPubkeys.length} public keys already registered, removed them from the list.`
    );

    const { signer, adapter } = await getSignerandAdapter(
      process.env.RPC_ENDPOINT,
      process.env.PRIVATE_KEY
    );
    // need to initialize these
    let nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
    let expectedNonce = nonce;

    for (let keysharesChunk of [...chunks(keyshares, chunkSize)]) {
      // update nonce
      console.info(`Obtaining owner nonce`);
      nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
      console.info(`Owner nonce: ${nonce}`);
      // expected to be the same on first loop, but important on following ones
      if (nonce !== expectedNonce) {
        console.error(
          "Nonce has not been updated since last successful transaction!"
        );
        break;
      }
      console.info("Verifying Keyshares validity");
      try {
        // test keyshares validity
        await areKeysharesValid(
          keysharesChunk,
          expectedNonce,
          process.env.SAFE_ADDRESS
        );
      } catch (error) {
        let keyshareFilesWithIssues = Array.from(
          new Set(
            keysharesChunk.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          problems.set(
            keyshareFileWithIssues,
            `Keyshares verification failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }
      console.info(`All Keyshares valid`);

      console.info(
        `Generating transaction data to register ${keysharesChunk.length} keys to ${process.env.SAFE_ADDRESS} account`
      );
      let bulkRegistrationTxData;
      try {
        // build tx
        bulkRegistrationTxData = await getBulkRegistrationTxData(
          keysharesChunk,
          process.env.SAFE_ADDRESS,
          signer
        );
      } catch (error) {
        let keyshareFilesWithIssues = Array.from(
          new Set(
            keysharesChunk.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          problems.set(
            keyshareFileWithIssues,
            `Bulk Registration TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }
      console.info(`Successfully generated transaction`);

      console.info(
        "Generating multisig transaction with bulk transaction data"
      );
      try {
        // create multi sig tx
        let multiSigTransaction = await createApprovedMultiSigTx(
          adapter,
          bulkRegistrationTxData
        );
        console.info(`Created multi-sig transaction.`);
        // verify status
        console.info(
          `Verifying multisig transaction signatures and threshold.`
        );
        await checkAndExecuteSignatures(adapter, multiSigTransaction);
      } catch (error) {
        let keyshareFilesWithIssues = Array.from(
          new Set(
            keysharesChunk.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          problems.set(
            keyshareFileWithIssues,
            `Multi-sig TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }

      console.info(
        `Transaction successfully executed. Next user nonce is ${
          nonce + keyshares.length
        }`
      );

      // update expected nonce, if everything went as expected, data source should have exact same increment
      expectedNonce = nonce + chunkSize;
    }
    console.info(`Finished processing ${keyshares.length} keyshares`);

    console.info(`\nEncountered ${problems.size} problem(s)\n`);

    for (let problem of problems) {
      console.error(
        `\nEncountered issue when processing keystore file: ${problem[0]}`
      );
      console.error(`\n${problem[1]}\n\n`);
    }

    console.info(`Done. Exiting script.`);
  });
