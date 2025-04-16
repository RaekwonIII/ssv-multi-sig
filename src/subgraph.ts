import axios from "axios";
import retry from "retry";

type RetryOptions = {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
  randomize: boolean;
};

export function retryWithExponentialBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  return new Promise((resolve, reject) => {
    const operationRetry = retry.operation(options);

    operationRetry.attempt(() => {
      operation()
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
  const defaultSnapshot: ClusterSnapshot = {
    validatorCount: 0,
    networkFeeIndex: 0,
    index: 0,
    active: true,
    balance: 0,
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
      console.error("Request did not return OK");
      return defaultSnapshot;
    }

    if (response.data.data.clusters && response.data.data.clusters.length > 0) {
      return response.data.data.clusters[0];
    }

    return defaultSnapshot;
  } catch (err) {
    console.error("Error getting cluster snapshot:", err);
    return defaultSnapshot;
  }
}
