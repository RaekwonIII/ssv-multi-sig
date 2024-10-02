import axios from "axios";
import { ClusterSnapshot, ShareObject, ValidatorRegistrationData } from "./utils";

export async function getOwnerNonceFromSubgraph(
  owner: string
): Promise<number> {
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
    if (response.data.data.account)
      nonce = Number(response.data.data.account.nonce);

  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return nonce;
  }
}

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
          operatorIds: operatorIDs,
        },
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

export async function getRegisteredPubkeys(pubkeys: string[]): Promise<string[]> {
  let registeredPubkeys: string[] = [];
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
            query getRegisteredPubkeys($pubkeys: [Bytes!]) {
                validators(where: {id_in: $pubkeys, active: true}, first: 1000) {
                    id
                }
            }`,
        variables: { pubkeys: pubkeys },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");
    if (!response.data.data.validators) throw Error("Response is empty");

    let pubkeysList = response.data.data.validators;

    registeredPubkeys = pubkeysList.map((item: { id: string; }) => item.id)
  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return registeredPubkeys;
  }
}

export async function getValidatorCountPerOperator(operatorIds:number[]): Promise<{id: number, validatorCount: number}[]> {
  
  let validatorCountPerOperator = [];
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
            query getValidatorCountPerOperator($operatorIds: [BigInt!]) {
              operators(where: {operatorId_in: $operatorIds}) {
                id
                validatorCount
              }
            }`,
        variables: { operatorIds: operatorIds },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");
    if (!response.data.data.operators) throw Error("Response is empty");

    validatorCountPerOperator = response.data.data.operators.map((item: { id: string; validatorCount: string; }) => {
      return {
        id: parseInt(item.id),
        validatorCount: parseInt(item.validatorCount)
      }
    });

  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return validatorCountPerOperator;
  }
}

export async function getValidatorRegistrationData(txhash: string): Promise<ValidatorRegistrationData | undefined> {
  let returnData
  let validatorData: ShareObject[] = [];
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
            query getValidatorRegistrationData($txhash: Bytes) {
                validatorAddeds(
                  where: {transactionHash: $txhash}
                  orderBy: id
                  orderDirection: asc
                ) {
                  publicKey
                  shares
                  owner
                  operatorIds
                  blockNumber
                }
            }`,
        variables: { txhash: txhash },
      },
    });

    if (response.status !== 200) throw Error("Request did not return OK");
    if (!response.data.data.validatorAddeds) throw Error("Response is empty");
    if (response.data.data.validatorAddeds.length === 0) throw Error("No events found");

    let result = response.data.data.validatorAddeds;

    validatorData = result.map((item: any) => {
      return {
        keySharesFilePath: "",
        data: {
          ownerNonce: 0,
          ownerAddress: item.owner,
          publicKey: item.publicKey,
          operators: [
            {
              id: 0,
              operatorKey: "",
            },
          ],
        },
        payload: {
          publicKey: item.publicKey,
          operatorIds: item.operatorIds.map((id: string) => parseInt(id)),
          sharesData: item.shares
        }
      }
    })
    returnData = {
      sharesObjArr: validatorData,
      blockNumber: result[0].blockNumber,
      ownerAddress: result[0].owner
    }
  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return returnData;
  }
}

export async function getOwnerNonceAtBlock(
  owner: string,
  block: number,
): Promise<number> {
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
            query accountNonce($owner: ID!, $block: Block_height) {
              account(id: $owner, block: $block) {
                  nonce
              }
          }`,
        variables: { owner: owner, block: block },
      },
    });
    if (response.status !== 200) throw Error("Request did not return OK");
    if (response.data && response.data.data && response.data.data.account)
      nonce = Number(response.data.data.account.nonce);

  } catch (err) {
    console.error("ERROR DURING AXIOS REQUEST", err);
  } finally {
    return nonce;
  }
}
