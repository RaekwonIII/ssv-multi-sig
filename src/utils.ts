import { readFileSync } from "fs";
import { glob } from "glob";

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
  console.info(`Found ${keysharesObjectsList.length} total keyshares`);

  return keysharesObjectsList;
}
