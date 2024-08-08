import axios from "axios";
import { ClusterSnapshot } from "./utils";

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
                validators(where: {id_in: $pubkeys, active: true}) {
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
