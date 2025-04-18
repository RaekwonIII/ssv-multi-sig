import axios from "axios";

export type ClusterSnapshot = {
  validatorCount: number;
  networkFeeIndex: bigint,
  index: bigint,
  active: boolean,
  balance: bigint,
}

export async function getClusterSnapshot(
  owner: string,
  operatorIDs: number[]
): Promise<ClusterSnapshot> {

  let clusterSnapshot: ClusterSnapshot = {
    validatorCount: 0,
    networkFeeIndex: BigInt(0),
    index: BigInt(0),
    active: true,
    balance: BigInt(0),
  };

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

  try {
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

    if (response.status !== 200) {
      console.error("Request did not return OK,");
    }

    if (response.data.data.clusters && response.data.data.clusters.length > 0) {
      const cluster = response.data.data.clusters[0];
      clusterSnapshot = {
        validatorCount: Number(cluster.validatorCount),
        networkFeeIndex: BigInt(cluster.networkFeeIndex),
        index: BigInt(cluster.index),
        active: cluster.active,
        balance: BigInt(cluster.balance),
      }
    }

    return clusterSnapshot;
  } catch (err) {
    console.error("Error getting cluster snapshot:", err);
    return clusterSnapshot;
  }
}
