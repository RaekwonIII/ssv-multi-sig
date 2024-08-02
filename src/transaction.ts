import { ethers } from "ethers";
import { getClusterSnapshot } from "./subgraph";
import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import SSVContract from "../abi/SSVNetwork.json";
import Safe from "@safe-global/protocol-kit";
import { ShareObject } from "./utils";
import { EthersAdapter } from "@safe-global/protocol-kit";

export async function getSignerandAdapter(endpoint:string, privateKey: string) {
    const provider = new ethers.JsonRpcProvider(endpoint);
    const signer = new ethers.Wallet(privateKey, provider);
    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    });
    return {
        signer: signer,
        adapter: ethAdapter,
    }
}

export async function getBulkRegistrationTxData(
  sharesDataObjectArray: ShareObject[],
  owner: string,
  signer: ethers.Wallet
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
  const clusterSnapshot = await getClusterSnapshot(owner, operatorIds);

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

export async function createApprovedMultiSigTx(
  ethAdapter: EthersAdapter,
  transaction_data: string
) {
  // Create Safe instance
  let protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: `${process.env.SAFE_ADDRESS}`,
  });

  // Create transaction
  const safeTransactionData: MetaTransactionData = {
    to: `${process.env.SSV_CONTRACT}`,
    value: "0",
    data: transaction_data,
    operation: OperationType.Call,
  };

  return await protocolKit.createTransaction({
    transactions: [safeTransactionData],
  });
}

export async function checkAndExecuteSignatures(
  ethAdapter: EthersAdapter,
  safeTransaction: SafeTransaction
) {
  // Create Safe instance
  const protocolKit = await Safe.create({
    ethAdapter,
    safeAddress: `${process.env.SAFE_ADDRESS}`,
  });

  console.debug("Validating transaction...");
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const isValidTx = await protocolKit.isValidTransaction(safeTransaction);
  if (!isValidTx)
    throw Error(
      `Transaction ${safeTxHash} is deemed invalid by the SDK, please verify.`
    );

  console.debug("Transaction is valid.");
  console.debug("Signing transaction...");
  const approveTxResponse = await protocolKit.approveTransactionHash(
    safeTxHash
  );
  await approveTxResponse.transactionResponse?.wait();
  console.debug("Transaction signed.");

  const threshold = await protocolKit.getThreshold();
  const numberOfApprovers = (
    await protocolKit.getOwnersWhoApprovedTx(safeTxHash)
  ).length;

  if (numberOfApprovers < threshold) {
    throw Error(
      `Approval threshold is ${threshold}, and only ${numberOfApprovers} have been made, transaction ${safeTxHash} cannot be executed.`
    );
  }

  console.debug("Approval threshold reached, executing transaction...");
  const executeTxResponse = await protocolKit.executeTransaction(
    safeTransaction
  );
  const receipt =
    executeTxResponse.transactionResponse &&
    (await executeTxResponse.transactionResponse.wait());

  if (Number(await protocolKit.getChainId()) === 1)
    console.log(
      "Transaction executed: https://etherscan.io/tx/" + receipt?.hash
    );
  else
    console.log(
      "Transaction executed: https://holesky.etherscan.io/tx/" + receipt?.hash
    );
  return receipt?.hash;
}
