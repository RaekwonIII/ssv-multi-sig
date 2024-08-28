import { readFileSync } from "fs";
import { glob } from "glob";
import * as retry from "retry"

export type ClusterSnapshot = {
  validatorCount: number;
  networkFeeIndex: number;
  index: number;
  active: boolean;
  balance: number;
};

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

// generator function to split the list of keyshares into chunks
// this is needed because there is a limit on the number of public keys
// that can be added to a bulk transaction
export function* chunks<T>(arr: T[], n: number): Generator<T[], void> {
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n);
  }
}

export function commaSeparatedList(
  value: string,
  dummyPrevious: any
): string[] {
  return value.split(",");
}

export async function getKeyshareObjects(
  dir: string
): Promise<Array<ShareObject>> {
  let keyshareFilesPathList = await glob(`${dir}/**/keyshares**.json`, {
    nodir: true,
  });
  console.info(
    `\nFound ${keyshareFilesPathList.length} keyshares files in ${dir} folder`
  );
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

  return keysharesObjectsList;
}

export function debug(args: any) {

  if (process.env.DEBUG) {
    console.debug(args);
  }
}

export function retryWithExponentialBackoff(operation: (operationOptions: any) => Promise<any>, operationOptions: any, options: any) {
  return new Promise((resolve, reject) => {
    const operationRetry = retry.operation(options)

    operationRetry.attempt(() => {
      operation(operationOptions)
        .then((result) => {
          resolve(result)
        })
        .catch((err) => {
          if (operationRetry.retry(err)) {
            return
          }
          reject(operationRetry.mainError())
        })
    })
  })
}
