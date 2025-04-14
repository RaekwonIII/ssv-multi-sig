/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from "commander";
import { SSVSDK, chains } from "@ssv-labs/ssv-sdk";
import { createClusterId } from '@ssv-labs/ssv-sdk/utils'
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import * as fs from "fs";
import { privateKeyToAccount } from "viem/accounts";
import { createValidatorKeys, ValidatorKeys } from "./generate.js";
import { checkAndExecuteSignatures, createApprovedMultiSigTx, getSafeProtocolKit } from "./transaction.js";
import SSVContract from "../abi/SSVNetwork.json";
import axios from "axios";
import { ethers } from "ethers";

import * as dotenv from "dotenv";
dotenv.config();

export const register = new Command("register");

const MAX_VALIDATORS_PER_OPERATOR = 1000;

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
    if (!process.env.KEYSTORES_OUTPUT_DIRECTORY)
      throw Error("Keystores output directory not provided");
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

    // find the operator with the maximum number of validators, and the value itself
    const maxVcountOperator = operatorsData.reduce(function (prev, current) {
      return prev && prev.validatorCount > current.validatorCount
        ? prev
        : current;
    });
    console.log(`Operator with the most validators registered to it has ${maxVcountOperator.validatorCount} keys`)

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

    let totalKeysRegistered = 0;

    while (totalKeysRegistered < keysCount) {
      // generate the maximum number of keys that can be registered in a single transaction
      console.log(`Creating keystores`)
      const keys = await createValidatorKeys({
        count: chunkSize,
        withdrawal: process.env.OWNER_ADDRESS as `0x${string}`,
        password: process.env.KEYSTORE_PASSWORD,
      });
      
      console.log(`Done.`)
      // get the user nonce
      const nonce = Number(
        await sdk.api.getOwnerNonce({ owner: process.env.OWNER_ADDRESS })
      );
      
      console.log("Initial nonce: ", nonce);
      
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
      writeKeysToFiles(keys, keysharesPayloads, process.env.KEYSTORES_OUTPUT_DIRECTORY);

      // Transform keysharesPayloads into ShareObject type
      const shareObjects: ShareObject[] = keysharesPayloads.map((payload: any) => ({
        keySharesFilePath: `${process.env.KEYSTORES_OUTPUT_DIRECTORY}/keyshares-${keys.masterSKHash}.json`,
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

      const clusterSnapshot = await getClusterSnapshot(process.env.OWNER_ADDRESS, operatorIds)
      
      if (!clusterSnapshot) {
        throw new Error("Failed to get cluster snapshot");
      }
      
      // Format cluster snapshot according to contract requirements
      const formattedClusterSnapshot = {
        validatorCount: Number(clusterSnapshot.validatorCount || 0),
        networkFeeIndex: BigInt(clusterSnapshot.networkFeeIndex || 0),
        index: BigInt(clusterSnapshot.index || 0),
        active: clusterSnapshot.active || false,
        balance: BigInt(clusterSnapshot.balance || 0)
      }
      
      // Convert walletClient to ethers Wallet
      const ethersWallet = new ethers.Wallet(private_key, new ethers.JsonRpcProvider(process.env.RPC_ENDPOINT));
      
      let txData = await getBulkRegistrationTxData(shareObjects, process.env.OWNER_ADDRESS, ethersWallet, formattedClusterSnapshot)

      // generate Safe TX
      const multiSigTransaction = await createApprovedMultiSigTx(safeProtocolKit, txData)
      await checkAndExecuteSignatures(safeProtocolKit, multiSigTransaction);

      totalKeysRegistered += chunkSize;
    }
  });

function writeKeysToFiles(keys: ValidatorKeys, keysharesPayloads: unknown, outputPath: string): void {
  // write seed phrase
  fs.writeFile(
    `${outputPath}/master-${keys.masterSKHash}`,
    keys.masterSK.toString(),
    (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Seed phrase saved to file`);
      }
    }
  );

  // write deposit file
  fs.writeFile(
    `${outputPath}/deposit_data-${keys.masterSKHash}.json`,
    JSON.stringify(keys.deposit_data),
    (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Deposit data saved to file`);
      }
    }
  );
  
  // write keyshares file
  fs.writeFile(
    `${outputPath}/keyshares-${keys.masterSKHash}.json`,
    JSON.stringify(keysharesPayloads),
    (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        console.log(`Keyshares saved to file`);
      }
    }
  );
  // write keystores
  for (const [i, keyshare] of keys.keystores.entries()) {
    const KEYSTORE_FILEPATH_TEMPLATE = `${outputPath}/keystore-m_12381_3600_${i}_0_0-${keys.masterSKHash}.json`;
    
    const keyshareString = JSON.stringify(keyshare);
    // Save the error message to a local file
    fs.writeFile(KEYSTORE_FILEPATH_TEMPLATE, keyshareString, (err) => {
      if (err) {
        console.error("Failed to write to file: ", err);
      } else {
        // console.log(`Operators saved to file: ${outputPath}`);
      }
    });
  }
  console.log(`Keystores files saved: ${outputPath}`);
}

function commaSeparatedList(value: string, _dummyPrevious: unknown) {
  return value.split(",").map((item: string) => parseInt(item));
}


export type ShareObject = {
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
export type ClusterSnapshot = {
  validatorCount: number;
  networkFeeIndex: number;
  index: number;
  active: boolean;
  balance: number;
};

export async function getClusterSnapshot(
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
    const query = `
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
    `;
    const variables = {
      owner: owner,
      operatorIds: operatorIDs,
    };

    console.log("GraphQL Query:", query);
    console.log("Query Variables:", JSON.stringify(variables, null, 2));

    const response = await axios({
      method: "POST",
      url:
        process.env.SUBGRAPH_API ||
        "https://api.studio.thegraph.com/query/71118/ssv-network-holesky/version/latest/",
      headers: {
        "content-type": "application/json",
      },
      data: {
        query,
        variables,
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");

    if (response.data.data.clusters && response.data.data.clusters.length > 0)
      clusterSnapshot = response.data.data.clusters[0];

    console.debug(
      `Cluster snapshot: { validatorCount: ${clusterSnapshot.validatorCount}, networkFeeIndex: ${clusterSnapshot.networkFeeIndex}, index: ${clusterSnapshot.index}, active: ${clusterSnapshot.active}, balance: ${clusterSnapshot.balance},}`
    );
  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return clusterSnapshot;
  }
}

export async function getBulkRegistrationTxData(
  sharesDataObjectArray: ShareObject[],
  owner: string,
  signer: ethers.Wallet,
  clusterSnapshot: {
    validatorCount: number;
    networkFeeIndex: bigint;
    index: bigint;
    active: boolean;
    balance: bigint;
  }
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

  console.log(`==============================================`)
  // Convert BigInt values to strings for logging
  const loggableClusterSnapshot = {
    ...clusterSnapshot,
    networkFeeIndex: clusterSnapshot.networkFeeIndex.toString(),
    index: clusterSnapshot.index.toString(),
    balance: clusterSnapshot.balance.toString()
  };
  console.log(`Cluster snapshot: ${JSON.stringify(loggableClusterSnapshot)}`);
  console.log(`==============================================`)

  return transaction.data;
}