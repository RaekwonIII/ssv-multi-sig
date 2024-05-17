import { Command } from "commander";
import {
  spinnerError,
  spinnerSuccess,
  stopSpinner,
  updateSpinnerText,
} from "../spinner";
import figlet from "figlet";
import axios from "axios";
import {
  MetaTransactionData,
  OperationType,
  SafeTransaction
} from "@safe-global/safe-core-sdk-types";

import { readFileSync } from "fs";
import { glob } from "glob";

import SSVContract from "../../abi/SSVNetwork.json";

import { ethers } from "ethers";
import { EthersAdapter } from "@safe-global/protocol-kit";
import Safe from "@safe-global/protocol-kit";

export const etherfi = new Command("etherfi");

type ClusterSnapshot = {
  validatorCount: number;
  networkFeeIndex: number;
  index: number;
  active: boolean;
  balance: number;
};

type ShareObject = {
  keySharesFilePath: string;
  data: {
    ownerNonce: number;
    ownerAddress: string;
    publicKey: string;
    operators: [
      {
        id: number;
        operatorKey: string;
      }
    ];
  };
  payload: {
    publicKey: string;
    operatorIds: number[];
    sharesData: string;
  };
};

// generator function to split the list of keyshares into chunks
// this is needed because there is a limit on the number of public keys
// that can be added to a bulk transaction
function* chunks<T>(arr: T[], n: number): Generator<T[], void> {
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n);
  }
}

etherfi
  .version("0.0.1", "-v, --vers", "output the current version")
  .argument(
    "<directory>",
    "The path to the directory containing keyshare files"
  )
  .option(
    "-o, --operators <operators>",
    "Comma separated list of ids of operators to test",
    commaSeparatedList
  )
  .action(async (directory, options) => {
    console.info(figlet.textSync("SSV <> EtherFi"));
    console.info("Automating registration of multiple validators for a Safe multisig wallet.");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");
    if (!process.env.RPC_ENDPOINT) throw Error("No RPC endpoint provided");
    if (!process.env.PRIVATE_KEY) throw Error("No Private Key provided");

    let clusterSnapshot = await getClusterSnapshot(
      process.env.SAFE_ADDRESS,
      options.operators.map((operator: string) => Number(operator))
    );
    let nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
    let problems = new Map();

    let keyshares = await getKeyshareObjects(
      directory,
      clusterSnapshot.validatorCount
    );

    const provider = new ethers.JsonRpcProvider(process.env.RPC_ENDPOINT);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    });


    for (let fourtyKeyshares of [...chunks(keyshares, 2)]) {
      let bulkRegistrationTxData
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
        let keyshareFilesWithIssues = Array.from(new Set(fourtyKeyshares.map((keyshares) => keyshares.keySharesFilePath)))
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          console.error(`Bulk Registration TX failed for file ${keyshareFileWithIssues}`)
          problems.set(
            keyshareFileWithIssues,
            `Bulk Registration TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        continue;
      }
      
      try {
        // create multi sig tx
        let multiSigTransaction = await createApprovedMultiSigTx(
          ethAdapter,
          bulkRegistrationTxData
        );
        console.info("Created multi-sig transaction.")
        // verify status
        await checkAndExecuteSignatures(ethAdapter, multiSigTransaction);
      }
      catch (error) {
        spinnerError();
        stopSpinner();
        let keyshareFilesWithIssues = Array.from(new Set(fourtyKeyshares.map((keyshares) => keyshares.keySharesFilePath)))
        for (let keyshareFileWithIssues of keyshareFilesWithIssues) {
          console.error(`Multi-sig TX failed for file ${keyshareFileWithIssues}`)
          problems.set(
            keyshareFileWithIssues,
            `Multi-sig TX failed for file ${keyshareFileWithIssues}:\n${error}`
          );
        }
        continue;
      }
    }

    spinnerSuccess();
    // increment nonce
    nonce = nonce + keyshares.length;
    updateSpinnerText(`Next user nonce is ${nonce}`);
    spinnerSuccess();

    console.log(`Encountered ${problems.size} problem(s)\n`);

    for (let problem of problems) {
      console.error(`Encountered issue when processing keystore file: ${problem[0]}`);
      console.error(problem[1]);
    }

    console.log(`Done. Exiting script.`);
    spinnerSuccess();
  });

function commaSeparatedList(value: string, dummyPrevious: any): string[] {
  return value.split(",");
}

async function getOwnerNonceFromSubgraph(owner: string): Promise<number> {
  let nonce = 0;
  try {
    const response = await axios({
      method: "POST",
      url:
        process.env.SUBGRAPH_API ||
        "https://api.studio.thegraph.com/query/71118/ssv-network-holesky/version/latest",
      headers: {
        "content-type": "application/json",
      },
      data: {
        query: `
            query accountNonce($owner: String!) {
                account(id: $owner) {
                    nonce
                }
            }`,
        variables: { owner: owner.toLowerCase() },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");
    if (!response.data.data.account) throw Error("Response is empty");

    let ownerObj = response.data.data.account;

    console.debug(`Owner nonce: ${ownerObj.nonce}`);
    nonce = Number(ownerObj.nonce);
  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return nonce;
  }
}

async function getClusterSnapshot(
  owner: string,
  operatorIDs: number[]
): Promise<ClusterSnapshot> {
  let clusterSnapshot: ClusterSnapshot = {
    validatorCount: 0,
    networkFeeIndex: 0,
    index: 0,
    active: true,
    balance: 0,
  };
  try {
    const response = await axios({
      method: "POST",
      url:
        process.env.SUBGRAPH_API ||
        "https://api.studio.thegraph.com/query/71118/ssv-network-holesky/version/latest",
      headers: {
        "content-type": "application/json",
      },
      data: {
        query: `
            query clusterSnapshot($cluster: String!) {
              cluster(id: $cluster) {
                validatorCount
                networkFeeIndex
                index
                active
                balance
              }
            }`,
        variables: {
          cluster: `${owner.toLowerCase()}-${operatorIDs.join("-")}`,
        },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");

    if (!response.data.data.cluster) {
        clusterSnapshot = {
        validatorCount: 0,
        networkFeeIndex: 0,
        index: 0,
        active: true,
        balance: 0
      }
    } else {
      clusterSnapshot = response.data.data.cluster
    }
    console.debug(`Cluster snapshot: { validatorCount: ${clusterSnapshot.validatorCount}, networkFeeIndex: ${clusterSnapshot.networkFeeIndex}, index: ${clusterSnapshot.index}, active: ${clusterSnapshot.active}, balance: ${clusterSnapshot.balance},}`
  )
  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return clusterSnapshot;
  }
}

async function getKeyshareObjects(
  dir: string,
  clusterValidators: number
): Promise<Array<ShareObject>> {
  let keyshareFilesPathList = await glob(`${dir}/**/keyshares**.json`, {
    nodir: true,
  });
  console.info(
    `Found ${keyshareFilesPathList.length} keyshares files in ${dir} folder`
  );
  let validatorsCount = clusterValidators;
  let keysharesObjectsList: Array<ShareObject> = []
  keyshareFilesPathList.map((keyshareFilePath) => {
    let shares : ShareObject[] = JSON.parse(readFileSync(keyshareFilePath, "utf-8")).shares;
    // Enrich the shares object with the keyshares file it was found in
    let enrichedShares = shares.map((share) => {
      share.keySharesFilePath = keyshareFilePath
      return share;
    });
    keysharesObjectsList.push(...enrichedShares)
  })

  // order by nonce
  keysharesObjectsList.sort((a, b) => a.data.ownerNonce - b.data.ownerNonce)
  
  if (validatorsCount + keysharesObjectsList.length > 500) {
    // identify the item in the list that's going to be the last one
    let lastKeysharesIndex = 500 - validatorsCount
    let lastKeyshareObj = keysharesObjectsList.at(lastKeysharesIndex)
    console.error(
      `Pubkey ${lastKeyshareObj?.payload.publicKey} is going to cause operators to reach maximum validators. 
      Going to only include files up to ${lastKeyshareObj?.keySharesFilePath} and only public keys preceding this one.`
    );
    // splice the array, effectively reducing it to the correct number
    keysharesObjectsList.splice(lastKeysharesIndex)
  }

  return keysharesObjectsList;
}

async function getBulkRegistrationTxData(
  sharesDataObjectArray: ShareObject[],
  owner: string,
  signer: ethers.Wallet
) {

  let contract = new ethers.Contract(
    process.env.SSV_CONTRACT || "",
    SSVContract,
    signer
  );

  let pubkeys = sharesDataObjectArray.map((keyshareFile) => {
    return keyshareFile.payload.publicKey;
  });

  let sharesData = sharesDataObjectArray.map((keyshareFile) => {
    return keyshareFile.payload.sharesData;
  });

  let operatorIds = sharesDataObjectArray[0].payload.operatorIds;
  let amount = ethers.parseEther("10");
  const clusterSnapshot = await getClusterSnapshot(owner, operatorIds);

  let transaction = await contract.bulkRegisterValidator.populateTransaction(
    pubkeys,
    operatorIds,
    sharesData,
    amount,
    clusterSnapshot,
    {
      gasLimit: 3000000, // gas estimation does not work
    }
  );

  return transaction.data;
}

async function createApprovedMultiSigTx(
  ethAdapter: EthersAdapter,
  transaction_data: string
) {


  // Create Safe instance
  let protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: `${process.env.SAFE_ADDRESS}`,

  });
  
  // Create transaction
  const safeTransactionData: MetaTransactionData = {
    to: `${process.env.SSV_CONTRACT}`,
    value: "0",
    data: transaction_data,
    operation: OperationType.Call,
  };

  return await protocolKit.createTransaction({
    transactions: [safeTransactionData],
  });
}

async function checkAndExecuteSignatures(
  ethAdapter: EthersAdapter,
  safeTransaction: SafeTransaction
) {

  // Create Safe instance
  const protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: `${process.env.SAFE_ADDRESS}`,
  });

  console.debug("Validating transaction...")
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  const isValidTx = await protocolKit.isValidTransaction(safeTransaction);
  if (!isValidTx)
    throw Error(
      `Transaction ${safeTxHash} is deemed invalid by the SDK, please verify.`
    );

  console.debug("Transaction is valid.")
  console.debug("Signing transaction...")
  const approveTxResponse = await protocolKit.approveTransactionHash(safeTxHash)
  await approveTxResponse.transactionResponse?.wait()
  console.debug("Transaction signed.")

  const threshold = await protocolKit.getThreshold()
  const numberOfApprovers = (await protocolKit.getOwnersWhoApprovedTx(safeTxHash)).length

  if (numberOfApprovers < threshold) {
    throw Error(
      `Approval threshold is ${threshold}, and only ${numberOfApprovers} have been made, transaction ${safeTxHash} cannot be executed.`
    );
  }

  console.debug("Approval threshold reached, executing transaction...")
  const executeTxResponse = await protocolKit.executeTransaction(safeTransaction);
  const receipt =
    executeTxResponse.transactionResponse &&
    (await executeTxResponse.transactionResponse.wait());

  if(Number(await protocolKit.getChainId()) === 1)
    console.log("Transaction executed: https://etherscan.io/tx/" + receipt?.hash)
  else
    console.log("Transaction executed: https://holesky.etherscan.io/tx/" + receipt?.hash)
  return receipt?.hash;
}
