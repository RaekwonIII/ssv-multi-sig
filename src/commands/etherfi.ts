import { Command } from "commander";
import {
  spinnerError,
  spinnerSuccess,
  stopSpinner,
  updateSpinnerText,
} from "../spinner";
import figlet from "figlet";

import {
  chunks,
  commaSeparatedList,
  getKeyshareObjects,
} from "../utils";
import { areKeysharesValid } from "../ssv-keys";
import { getClusterSnapshot, getOwnerNonceFromSubgraph } from "../subgraph";
import {
  checkAndExecuteSignatures,
  createApprovedMultiSigTx,
  getSignerandAdapter,
  getBulkRegistrationTxData,
} from "../transaction";

export const etherfi = new Command("etherfi");

etherfi
  .version("0.0.1", "-v, --vers", "output the current version")
  .argument(
    "<directory>",
    "The path to the directory containing keyshare files"
  )
  .option(
    "-o, --operators <operators>",
    "Comma separated list of ids of operators to register to",
    commaSeparatedList
  )
  .action(async (directory, options) => {
    console.info(figlet.textSync("SSV <> EtherFi"));
    console.info(
      "Automating registration of multiple validators for a Safe multisig wallet."
    );
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");
    if (!process.env.CHUNK_SIZE)
      throw Error("No keyshares chunk size provided");

    let clusterSnapshot = await getClusterSnapshot(
      process.env.SAFE_ADDRESS,
      options.operators.map((operator: string) => Number(operator))
    );
    let problems = new Map();

    let keyshares = await getKeyshareObjects(
      directory,
      clusterSnapshot.validatorCount
    );

    const {signer, adapter} = await getSignerandAdapter(process.env.RPC_ENDPOINT, process.env.PRIVATE_KEY) 
    // need to initialize these
    let nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
    let expectedNonce = nonce;

    for (let fourtyKeyshares of [...chunks(keyshares, parseInt(process.env.CHUNK_SIZE))]) {
      // update nonce
      nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
      console.debug(`Owner nonce: ${nonce}`);
      if (nonce !== expectedNonce) {
        console.error("Nonce has not been updated since last successful transaction!")
        break;
      }
      try {
        // test keyshares validity
        areKeysharesValid(
          fourtyKeyshares,
          expectedNonce,
          process.env.SAFE_ADDRESS
        );
      } catch (error) {
        spinnerError();
        stopSpinner();
        let keyshareFilesWithIssues = Array.from(
          new Set(
            fourtyKeyshares.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          console.error(
            `Keyshares verification failed for file ${keyshareFileWithIssues}`
          );
          problems.set(
            keyshareFileWithIssues,
            `Keyshares verification failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }

      let bulkRegistrationTxData;
      try {
        // build tx
        bulkRegistrationTxData = await getBulkRegistrationTxData(
          fourtyKeyshares,
          process.env.SAFE_ADDRESS,
          signer
        );
      } catch (error) {
        spinnerError();
        stopSpinner();
        let keyshareFilesWithIssues = Array.from(
          new Set(
            fourtyKeyshares.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          console.error(
            `Bulk Registration TX failed for file ${keyshareFileWithIssues}`
          );
          problems.set(
            keyshareFileWithIssues,
            `Bulk Registration TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }

      try {
        // create multi sig tx
        let multiSigTransaction = await createApprovedMultiSigTx(
          adapter,
          bulkRegistrationTxData
        );
        console.info("Created multi-sig transaction.");
        // verify status
        await checkAndExecuteSignatures(adapter, multiSigTransaction);
      } catch (error) {
        spinnerError();
        stopSpinner();
        let keyshareFilesWithIssues = Array.from(
          new Set(
            fourtyKeyshares.map((keyshares) => keyshares.keySharesFilePath)
          )
        );
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          console.error(
            `Multi-sig TX failed for file ${keyshareFileWithIssues}`
          );
          problems.set(
            keyshareFileWithIssues,
            `Multi-sig TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        break;
      }

      spinnerSuccess();
      updateSpinnerText(`Next user nonce is ${nonce + keyshares.length}`);

      expectedNonce = nonce + parseInt(process.env.CHUNK_SIZE);
    }
    spinnerSuccess();

    console.log(`Encountered ${problems.size} problem(s)\n`);

    for (let problem of problems) {
      console.error(
        `Encountered issue when processing keystore file: ${problem[0]}`
      );
      console.error(problem[1]);
    }

    console.log(`Done. Exiting script.`);
    spinnerSuccess();
  });
