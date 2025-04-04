import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import SafeApiKit from "@safe-global/api-kit";

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

  console.debug("Generating transaction...");
  let safeTransaction = await protocolKit.createTransaction({
    transactions: [safeTransactionData],
  });

  console.debug(`Signatures before: ${JSON.stringify(safeTransaction.signatures)}`);
  console.debug(`Signing transaction...`)

  // three different ways in which the tx should be signed
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  // on-chain approval:
  const approveTxResponse = await protocolKit.approveTransactionHash(
    safeTxHash
  );
  // adding a signatures to the tx
  safeTransaction = await protocolKit.signTransaction(safeTransaction);

  const signature = await protocolKit.signHash(safeTxHash)
  // a different way to add a signature to the tx
  safeTransaction.addSignature(signature)

  // and yet, they don't seem to be working
  console.debug(`Signatures after: ${JSON.stringify(safeTransaction.signatures)}`);
  return safeTransaction;
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

  console.debug("Transaction is valid.");

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
