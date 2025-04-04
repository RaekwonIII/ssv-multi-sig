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
  // const approveTxResponse = await protocolKit.approveTransactionHash(
  //   safeTxHash
  // );
  
  // API kit tests section 🤷‍♂️
  console.debug("Signing transaction...");
  let apiKit;
  if (!process.env.TX_SERVICE) {
    apiKit = new SafeApiKit({
      chainId: 17000n,
    });
  } else {
    apiKit = new SafeApiKit({
      chainId: 17000n, // set the correct chainId
      txServiceUrl: process.env.TX_SERVICE
    });
  }
  console.debug(`Getting transaction...`)
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  console.debug(`...${safeTxHash}`)
  console.debug(`Generating signature...`)
  const signature = await protocolKit.signHash(safeTxHash)
  console.debug(`...signed: ${signature.data}`)
  
  console.debug(`Proposing signed transaction...`)
  // Propose transaction to the service
  await apiKit.proposeTransaction({
    safeAddress: process.env.SAFE_ADDRESS || "",
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: process.env.OWNER_ADDRESS || "",
    senderSignature: signature.data
  })
  
  console.debug(`Confirming transaction...`)
  const signatureResponse = await apiKit.confirmTransaction(
    safeTxHash,
    signature.data
  )
  console.debug(`Signing transaction...`)
  safeTransaction = await protocolKit.signTransaction(safeTransaction);

  console.debug(`Transaction signed: ${JSON.stringify(signatureResponse)}`);
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
