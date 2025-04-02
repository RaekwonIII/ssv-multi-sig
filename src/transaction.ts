import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import Safe from "@safe-global/protocol-kit";

export async function getSafeProtocolKit(
  rpc_url: string,
  signer: string,
  safe_address: string
): Promise<Safe> {
  const protocolKit = await Safe.init({
    provider: rpc_url,
    signer: signer,
    safeAddress: safe_address,
  });
  return protocolKit;
}

export async function createApprovedMultiSigTx(
  protocolKit: Safe,
  transaction_data: string
) {
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
  protocolKit: Safe,
  safeTransaction: SafeTransaction
) {
  console.debug("Validating transaction...");
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  const isValidTx = await protocolKit.isValidTransaction(safeTransaction);

  if (!isValidTx)
    throw Error(
      `Transaction ${safeTxHash} is deemed invalid by the SDK, please verify this transaction data: \n${safeTransaction.data.data}`
    );

  // const signature = await protocolKit.signHash(safeTxHash);
  // await apiKit.confirmTransaction(safeTxHash, signature.data);
  console.debug("Transaction is valid.");
  console.debug("Signing transaction...");
  const approveTxResponse = await protocolKit.approveTransactionHash(
    safeTxHash
  );
  // await approveTxResponse.transactionResponse?.wait();
  console.debug(`Transaction signed: ${approveTxResponse.transactionResponse}`);

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
  // const receipt =
  //   executeTxResponse.transactionResponse
  //   && (await executeTxResponse.transactionResponse.wait());

  if (Number(await protocolKit.getChainId()) === 1)
    console.log(
      "Transaction executed: https://etherscan.io/tx/" + executeTxResponse?.hash
    );
  else
    console.log(
      "Transaction executed: https://holesky.etherscan.io/tx/" +
        executeTxResponse?.hash
    );
  return executeTxResponse?.hash;
}
