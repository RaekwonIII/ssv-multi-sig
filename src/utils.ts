import retry from "retry";
import * as fs from "fs";
import { ValidatorKeys } from "./generate";
import { ethers } from "ethers";
import SSVContract from "../abi/SSVNetwork.json";

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
  sharesDataObjectArray: ShareObject[],
  ownerAddress: string,
  signer: ethers.Wallet,
  clusterSnapshot: {
    validatorCount: number;
    networkFeeIndex: bigint;
    index: bigint;
    active: boolean;
    balance: bigint;
  }
): Promise<string> {
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
