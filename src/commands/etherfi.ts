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
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import { readFileSync } from "fs";
import { glob } from "glob";

import SSVContract from "../../abi/SSVNetwork.json";

import { ethers } from "ethers";
import { EthersAdapter } from "@safe-global/protocol-kit";
import Safe from "@safe-global/protocol-kit";
import Web3 from "web3";
import * as ethUtil from "ethereumjs-util";
import bls from "bls-eth-wasm";

export const etherfi = new Command("etherfi");

const SIGNATURE_LENGHT = 192;
const PUBLIC_KEY_LENGHT = 96;

export interface IKeySharesFromSignatureData {
  ownerAddress: string;
  ownerNonce: number;
  publicKey: string;
}

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

    let clusterSnapshot = await getClusterSnapshot(
      process.env.SAFE_ADDRESS,
      options.operators.map((operator: string) => Number(operator))
    );
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

    for (let fourtyKeyshares of [...chunks(keyshares, 40)]) {
      // update nonce
      let nonce = await getOwnerNonceFromSubgraph(process.env.SAFE_ADDRESS);
      try {
        // test keyshares validity
        areKeysharesValid(fourtyKeyshares, nonce, process.env.SAFE_ADDRESS);
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
        continue;
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
        continue;
      }

      try {
        // create multi sig tx
        let multiSigTransaction = await createApprovedMultiSigTx(
          ethAdapter,
          bulkRegistrationTxData
        );
        console.info("Created multi-sig transaction.");
        // verify status
        await checkAndExecuteSignatures(ethAdapter, multiSigTransaction);
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
        continue;
      }

      spinnerSuccess();
      updateSpinnerText(`Next user nonce is ${nonce + keyshares.length}`);
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
          query accountNonce($owner: ID!) {
            account(id: $owner) {
                nonce
            }
        }`,
        variables: { owner: owner },
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
            query clusterSnapshot($owner: ID!, $operatorIds: [BigInt!]!) {
              clusters(
                where: {owner_: {id: $owner}, operatorIds: $operatorIds}
              ) {
                validatorCount
                networkFeeIndex
                index
                active
                balance
              }
            }
            `,
        variables: {
          owner: owner,
          operatorIds: operatorIDs
        },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");

    if (response.data.data.cluster)
      clusterSnapshot = response.data.data.cluster;

    console.debug(
      `Cluster snapshot: { validatorCount: ${clusterSnapshot.validatorCount}, networkFeeIndex: ${clusterSnapshot.networkFeeIndex}, index: ${clusterSnapshot.index}, active: ${clusterSnapshot.active}, balance: ${clusterSnapshot.balance},}`
    );
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
  let keysharesObjectsList: Array<ShareObject> = [];
  keyshareFilesPathList.map((keyshareFilePath) => {
    let shares: ShareObject[] = JSON.parse(
      readFileSync(keyshareFilePath, "utf-8")
    ).shares;
    // Enrich the shares object with the keyshares file it was found in
    let enrichedShares = shares.map((share) => {
      share.keySharesFilePath = keyshareFilePath;
      return share;
    });
    keysharesObjectsList.push(...enrichedShares);
  });

  // order by nonce
  keysharesObjectsList.sort((a, b) => a.data.ownerNonce - b.data.ownerNonce);

  if (validatorsCount + keysharesObjectsList.length > 500) {
    // identify the item in the list that's going to be the last one
    let lastKeysharesIndex = 500 - validatorsCount;
    let lastKeyshareObj = keysharesObjectsList.at(lastKeysharesIndex);
    console.error(
      `Pubkey ${lastKeyshareObj?.payload.publicKey} is going to cause operators to reach maximum validators. 
      Going to only include files up to ${lastKeyshareObj?.keySharesFilePath} and only public keys preceding this one.`
    );
    // splice the array, effectively reducing it to the correct number
    keysharesObjectsList.splice(lastKeysharesIndex);
  }

  return keysharesObjectsList;
}

async function validateSingleShares(
  shares: string,
  fromSignatureData: IKeySharesFromSignatureData
): Promise<void> {
  const { ownerAddress, ownerNonce, publicKey } = fromSignatureData;

  if (!Number.isInteger(ownerNonce) || ownerNonce < 0) {
    throw new Error(`Owner nonce is not positive integer ${ownerNonce}`);
  }
  const web3 = new Web3();
  const address = web3.utils.toChecksumAddress(ownerAddress);
  const signaturePt = shares.replace("0x", "").substring(0, SIGNATURE_LENGHT);

  // await web3Helper.validateSignature(`${address}:${ownerNonce}`, `0x${signaturePt}`, publicKey);

  if (!bls.deserializeHexStrToSecretKey) {
    await bls.init(bls.BLS12_381);
  }

  const blsPublicKey = bls.deserializeHexStrToPublicKey(
    publicKey.replace("0x", "")
  );
  const signature = bls.deserializeHexStrToSignature(
    `0x${signaturePt}`.replace("0x", "")
  );

  const messageHash = ethUtil.keccak256(
    Buffer.from(`${address}:${ownerNonce}`)
  );

  if (!blsPublicKey.verify(signature, new Uint8Array(messageHash))) {
    throw new Error(`Single shares signature is invalid 0x${signaturePt}`);
  }
}

function splitArray(parts: number, arr: Uint8Array) {
  const partLength = Math.floor(arr.length / parts);
  const partsArr = [];
  for (let i = 0; i < parts; i++) {
    const start = i * partLength;
    const end = start + partLength;
    partsArr.push(arr.slice(start, end));
  }
  return partsArr;
}

/**
 * Build shares from bytes string and operators list length
 * @param bytes
 * @param operatorCount
 */
function buildSharesFromBytes(bytes: string, operatorCount: number): any {
  // Validate the byte string format (hex string starting with '0x')
  if (!bytes.startsWith("0x") || !/^(0x)?[0-9a-fA-F]*$/.test(bytes)) {
    throw new Error("Invalid byte string format");
  }

  // Validate the operator count (positive integer)
  if (operatorCount <= 0 || !Number.isInteger(operatorCount)) {
    throw new Error("Invalid operator count");
  }

  const sharesPt = bytes.replace("0x", "").substring(SIGNATURE_LENGHT);

  const pkSplit = sharesPt.substring(0, operatorCount * PUBLIC_KEY_LENGHT);
  const pkArray = ethers.getBytes("0x" + pkSplit);
  const sharesPublicKeys = splitArray(operatorCount, pkArray).map((item) =>
    ethers.toBeHex(item.toString())
  );

  const eSplit = bytes.substring(operatorCount * PUBLIC_KEY_LENGHT);
  const eArray = ethers.getBytes("0x" + eSplit);
  const encryptedKeys = splitArray(operatorCount, eArray).map((item) =>
    Buffer.from(
      ethers.toBeHex(item.toString()).replace("0x", ""),
      "hex"
    ).toString("base64")
  );

  return { sharesPublicKeys, encryptedKeys };
}

async function areKeysharesValid(
  keysharesObjArray: ShareObject[],
  ownerNonce: number,
  owner: string
) {
  // let keySharesItemSDK = new KeySharesItem();
  for (let keysharesObj of keysharesObjArray) {
    let pubkey = keysharesObj.payload.publicKey;
    let sharesData = keysharesObj.payload.sharesData;
    let fromSignatureData = {
      ownerNonce,
      publicKey: pubkey,
      ownerAddress: owner,
    };

    const shares: { sharesPublicKeys: string[]; encryptedKeys: string[] } =
      buildSharesFromBytes(sharesData, keysharesObj.payload.operatorIds.length);
    const { sharesPublicKeys, encryptedKeys } = shares;
    await validateSingleShares(sharesData, fromSignatureData);

    const cantDeserializeSharePublicKeys = [];
    for (const sharesPublicKey of sharesPublicKeys) {
      try {
        bls.deserializeHexStrToPublicKey(sharesPublicKey.replace("0x", ""));
      } catch (e) {
        cantDeserializeSharePublicKeys.push(sharesPublicKey);
      }
    }
    if (cantDeserializeSharePublicKeys.length || !sharesPublicKeys.length) {
      throw new Error(JSON.stringify(cantDeserializeSharePublicKeys));
    }
    bls.deserializeHexStrToPublicKey(pubkey.replace("0x", ""));

    ownerNonce += 1;
  }
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

  let pubkeys = sharesDataObjectArray.map((keyshareObj) => {
    return keyshareObj.payload.publicKey;
  });

  let sharesData = sharesDataObjectArray.map((keyshareObj) => {
    return keyshareObj.payload.sharesData;
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

  console.debug("Validating transaction...");
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const isValidTx = await protocolKit.isValidTransaction(safeTransaction);
  if (!isValidTx)
    throw Error(
      `Transaction ${safeTxHash} is deemed invalid by the SDK, please verify.`
    );

  console.debug("Transaction is valid.");
  console.debug("Signing transaction...");
  const approveTxResponse = await protocolKit.approveTransactionHash(
    safeTxHash
  );
  await approveTxResponse.transactionResponse?.wait();
  console.debug("Transaction signed.");

  const threshold = await protocolKit.getThreshold();
  const numberOfApprovers = (
    await protocolKit.getOwnersWhoApprovedTx(safeTxHash)
  ).length;

  if (numberOfApprovers < threshold) {
    throw Error(
      `Approval threshold is ${threshold}, and only ${numberOfApprovers} have been made, transaction ${safeTxHash} cannot be executed.`
    );
  }

  console.debug("Approval threshold reached, executing transaction...");
  const executeTxResponse = await protocolKit.executeTransaction(
    safeTransaction
  );
  const receipt =
    executeTxResponse.transactionResponse &&
    (await executeTxResponse.transactionResponse.wait());

  if (Number(await protocolKit.getChainId()) === 1)
    console.log(
      "Transaction executed: https://etherscan.io/tx/" + receipt?.hash
    );
  else
    console.log(
      "Transaction executed: https://holesky.etherscan.io/tx/" + receipt?.hash
    );
  return receipt?.hash;
}
