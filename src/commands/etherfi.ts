import { Command } from "commander";
import {
  spinnerError,
  spinnerInfo,
  spinnerSuccess,
  stopSpinner,
  updateSpinnerText,
} from "../spinner";
import figlet from "figlet";
import axios from "axios";
import { EthersAdapter } from "@safe-global/protocol-kit";
import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  OperationType,
} from "@safe-global/safe-core-sdk-types";

import { ethers } from "ethers";

import { readFileSync } from "fs";

import SSVContract from "../../abi/SSVNetwork.json";
import SafeApiKit, { SafeApiKitConfig } from "@safe-global/api-kit";
import { glob } from "glob";

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
    console.info("Automating registration with multi-sig");
    if (!process.env.SAFE_ADDRESS) throw Error("No SAFE address provided");

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

    const provider = new ethers.JsonRpcProvider(`${process.env.RPC_ENDPOINT}`);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY || "", provider);
    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    });

    for (let fourtyKeyshares of [...chunks(keyshares, 40)]) {
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
        let multiSigTxHash = await createMultiSigTx(
          ethAdapter,
          bulkRegistrationTxData
        );
        // verify status
        await checkAndExecuteSignatures(ethAdapter, multiSigTxHash);
        // execute
        await checkAndExecuteSignatures(ethAdapter, multiSigTxHash);
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
    nonce += keyshares.length;
    updateSpinnerText(`Next user nonce is ${nonce}`);
    spinnerSuccess();

    console.log(`Encountered ${problems.size} problem(s)\n`);

    for (let problem of problems) {
      console.error(`Encountered issue with files ${problem[0]}`);
      console.error(problem[1]);
    }

    console.log(`Done. Next user nonce is ${nonce}`);
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
        "https://api.studio.thegraph.com/query/71118/ssv-network-ethereum/version/latest",
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

    console.debug(`Owner nonce:\n\n${ownerObj.nonce}`);
    nonce = ownerObj.nonce;
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
    active: false,
    balance: 0,
  };
  try {
    const response = await axios({
      method: "POST",
      url:
        process.env.SUBGRAPH_API ||
        "https://api.studio.thegraph.com/query/71118/ssv-network-ethereum/version/latest",
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
    if (!response.data.data.cluster) throw Error("Response is empty");

    let clusterObj = response.data.data.cluster;

    console.debug(`Cluster Snapshot:\n\n${clusterObj.validatorCount}`);
    clusterSnapshot = clusterObj;
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
    `Found ${keyshareFilesPathList.length} keyshares files in the provided folder`
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
  sharesDataArray: ShareObject[],
  owner: string,
  signer: ethers.Wallet
) {
  /* next, create the item */
  let contract = new ethers.Contract(
    process.env.SSV_CONTRACT || "",
    SSVContract,
    signer
  );

  let pubkeys = sharesDataArray.map((sharesData) => {
    sharesData.payload.publicKey;
  });
  let operatorIds = sharesDataArray[0].payload.operatorIds;
  let amount = ethers.parseEther("10");
  const clusterSnapshot = await getClusterSnapshot(owner, operatorIds);

  // This needs approval for spending SSV token
  let transaction = await contract.bulkRegisterValidator(
    pubkeys,
    operatorIds,
    sharesDataArray,
    amount,
    clusterSnapshot,
    {
      gasLimit: 3000000, // gas estimation does not work
    }
  );

  // let res = await transaction.wait();
  console.debug(`Transaction data: `, transaction.data);
  return transaction.data;
}

async function createMultiSigTx(
  ethAdapter: EthersAdapter,
  transaction_data: string
) {
  const safeService = new SafeApiKit({
    // chainId: 17000n, // Holesky
    chainId: 1n, // Mainnet
  });

  // Create Safe instance
  const protocolKit = await Safe.create({
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

  const safeTransaction = await protocolKit.createTransaction({
    transactions: [safeTransactionData],
  });

  const senderAddress = await ethAdapter.getSigner()?.getAddress();
  if (!senderAddress) {
    console.error("No Ethereum signer provided");
    throw Error("No Ethereum signer provided");
  }
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const signature = await protocolKit.signHash(safeTxHash);

  // Propose transaction to the service
  await safeService.proposeTransaction({
    safeAddress: await protocolKit.getAddress(),
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: signature.data,
  });

  return safeTxHash;
}

async function checkAndExecuteSignatures(
  ethAdapter: EthersAdapter,
  safeTxHash: string
) {
  let apiConfObj: SafeApiKitConfig = {
    // if the set network is holesky, use its chain ID, otherwise, if mainnet, use its chain ID. Defaults to mainnet
    chainId: process.env.NETWORK == "holesky" ? 1700n : process.env.NETWORK == "mainnet" ? 1n : 1n
  }
  // if the configuration provides a transaction service, set it
  if (process.env.TX_SERVICE && process.env.TX_SERVICE !== "") apiConfObj.txServiceUrl = process.env.TX_SERVICE

  const safeService = new SafeApiKit(apiConfObj);
  const tx = await safeService.getTransaction(safeTxHash);

  const confirmations = await safeService.getTransactionConfirmations(
    safeTxHash
  );

  // if signatures >> treshold: execute
  // else: sign
  if (confirmations.count < tx.confirmationsRequired) {
    // complain
    throw Error(
      `Transaction threshold is ${tx.confirmationsRequired}, and ${confirmations.count} have been made`
    );
  }

  // // Create Safe instance
  const protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: `${process.env.SAFE_ADDRESS}`,
  });
  const isValidTx = await protocolKit.isValidTransaction(tx);
  if (!isValidTx)
    throw Error(
      `Transaction ${safeTxHash} is deemed invalid by the SDK, please verify that on the webapp.`
    );

  const executeTxResponse = await protocolKit.executeTransaction(tx);
  const receipt =
    executeTxResponse.transactionResponse &&
    (await executeTxResponse.transactionResponse.wait());
  return receipt?.hash;
}
