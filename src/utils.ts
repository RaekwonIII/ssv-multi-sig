import retry from "retry";
import * as fs from "fs";
import { ValidatorKeys } from "./generate";
import { ethers, Interface } from "ethers";
import SSVContract from "../abi/SSVNetwork.json";
import SSVContractHoodi from "../abi/SSVNetworkHoodi.json";

export type KeysharesPayload = {
  publicKey: string;
  operatorIds: number[];
  sharesData: string;
};

type ClusterSnapshotLike = {
  active: boolean;
  validatorCount: string | number | bigint;
  balance: string | number | bigint;
  index: string | number | bigint;
  networkFeeIndex: string | number | bigint;
};

export function retryWithExponentialBackoff<T>(
  operation: (operationOptions: any) => Promise<T>,
  operationOptions: any,
  options: any
): Promise<T> {
  return new Promise((resolve, reject) => {
    const operationRetry = retry.operation(options);

    operationRetry.attempt(() => {
      operation(operationOptions)
        .then((result) => {
          resolve(result);
        })
        .catch((err) => {
          if (operationRetry.retry(err)) {
            return;
          }
          reject(operationRetry.mainError());
        });
    });
  });
}

export function writeKeysToFiles(
  keys: ValidatorKeys,
  keysharesPayloads: unknown,
  outputPath: string
): void {
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

export async function getBulkRegistrationTxData(
  keysharesPayload: KeysharesPayload[],
  operatorIds: number[],
  signer: ethers.Wallet,
  clusterSnapshot:  {
    active: boolean;
    validatorCount: string;
    balance: string;
    index: string;
    networkFeeIndex: string;
}
): Promise<string> {
  const ssvContractAddress = process.env.SSV_CONTRACT;
  if (!ssvContractAddress) {
    throw new Error("No SSV contract address provided");
  }
  let contract = new ethers.Contract(
    ssvContractAddress,
    SSVContract,
    signer
  );

  let pubkeys = keysharesPayload.map((keyshareObj) => {
    return keyshareObj.publicKey;
  });

  let sharesData = keysharesPayload.map((keyshareObj) => {
    return keyshareObj.sharesData;
  });

  let amount = ethers.parseEther("0.1");

  console.log(`Current validator count: ${clusterSnapshot.validatorCount}`);

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

export function commaSeparatedList(value: string, _dummyPrevious: unknown) {
  return value.split(",").map((item: string) => parseInt(item));
}

export function getRegistrationTxDataV2(
  keysharesPayload: KeysharesPayload[],
  clusterSnapshot: ClusterSnapshotLike,
  depositAmount?: bigint,
): string {
  // Guard against generating invalid calldata for an empty batch.
  if (keysharesPayload.length === 0) {
    throw new Error("Cannot build tx data with empty keyshares payload");
  }

  // TESTNET uses Hoodi/V2 payable registration. Mainnet uses legacy amount-in-args registration.
  const isTestnet = Boolean(process.env.TESTNET);
  const iface = new Interface(isTestnet ? SSVContractHoodi : SSVContract);
  const operatorIds = keysharesPayload[0].operatorIds;
  // Normalize snapshot values into Solidity-friendly numeric types.
  // const normalizedCluster = {
  //   validatorCount: Number(clusterSnapshot.validatorCount),
  //   networkFeeIndex: BigInt(clusterSnapshot.networkFeeIndex),
  //   index: BigInt(clusterSnapshot.index),
  //   active: clusterSnapshot.active,
  //   balance: BigInt(clusterSnapshot.balance),
  // };

  // Route to the single-validator function when batch size is 1.
  if (keysharesPayload.length === 1) {
    if (isTestnet) {
      return iface.encodeFunctionData("registerValidator", [
        keysharesPayload[0].publicKey,
        operatorIds,
        keysharesPayload[0].sharesData,
        clusterSnapshot,
      ]);
    }
    return iface.encodeFunctionData("registerValidator", [
      keysharesPayload[0].publicKey,
      operatorIds,
      keysharesPayload[0].sharesData,
      depositAmount,
      clusterSnapshot,
    ]);
  }

  if (isTestnet) {
    return iface.encodeFunctionData("bulkRegisterValidator", [
      keysharesPayload.map((item) => item.publicKey),
      operatorIds,
      keysharesPayload.map((item) => item.sharesData),
      clusterSnapshot,
    ]);
  }

  return iface.encodeFunctionData("bulkRegisterValidator", [
    keysharesPayload.map((item) => item.publicKey),
    operatorIds,
    keysharesPayload.map((item) => item.sharesData),
    depositAmount,
    clusterSnapshot,
  ]);
}
