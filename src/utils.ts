import retry from "retry";
import * as fs from "fs";
import { ValidatorKeys } from "./generate";
import { Interface } from "ethers";
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

type RegistrationNetwork = "testnet" | "mainnet";

type RegistrationTxDataArgs = {
  keysharesPayload: KeysharesPayload[];
  clusterSnapshot: ClusterSnapshotLike;
  network: RegistrationNetwork;
  depositAmount?: bigint;
  operatorIds?: number[];
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

export function commaSeparatedList(value: string, _dummyPrevious: unknown) {
  return value.split(",").map((item: string) => parseInt(item));
}

// Build registration calldata and route to the ABI encoder for the selected network.
export function getRegistrationTxData(args: RegistrationTxDataArgs): string {
  if (args.keysharesPayload.length === 0) {
    throw new Error("Cannot build tx data with empty keyshares payload");
  }

  if (args.network === "testnet") {
    return encodeHoodiRegistrationTxData(args);
  }

  return encodeMainnetRegistrationTxData(args);
}

// Hoodi/testnet encoder: payable ABI where amount is sent as tx value, not as a function arg.
function encodeHoodiRegistrationTxData(args: RegistrationTxDataArgs): string {
  const iface = new Interface(SSVContractHoodi);
  const operatorIds = args.operatorIds ?? args.keysharesPayload[0].operatorIds;

  if (args.keysharesPayload.length === 1) {
    return iface.encodeFunctionData("registerValidator", [
      args.keysharesPayload[0].publicKey,
      operatorIds,
      args.keysharesPayload[0].sharesData,
      args.clusterSnapshot,
    ]);
  }

  return iface.encodeFunctionData("bulkRegisterValidator", [
    args.keysharesPayload.map((item) => item.publicKey),
    operatorIds,
    args.keysharesPayload.map((item) => item.sharesData),
    args.clusterSnapshot,
  ]);
}

// Mainnet encoder: nonpayable ABI where amount is passed as an explicit function arg.
function encodeMainnetRegistrationTxData(args: RegistrationTxDataArgs): string {
  const iface = new Interface(SSVContract);
  const operatorIds = args.operatorIds ?? args.keysharesPayload[0].operatorIds;

  if (args.keysharesPayload.length === 1) {
    return iface.encodeFunctionData("registerValidator", [
      args.keysharesPayload[0].publicKey,
      operatorIds,
      args.keysharesPayload[0].sharesData,
      args.depositAmount,
      args.clusterSnapshot,
    ]);
  }

  return iface.encodeFunctionData("bulkRegisterValidator", [
    args.keysharesPayload.map((item) => item.publicKey),
    operatorIds,
    args.keysharesPayload.map((item) => item.sharesData),
    args.depositAmount,
    args.clusterSnapshot,
  ]);
}
