import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import SafeApiKit from "@safe-global/api-kit";

import Safe from "@safe-global/protocol-kit";
import { TransactionResponse } from "ethers";
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
  console.debug("Received transaction data:", {
    length: transaction_data.length,
    firstChars: transaction_data.substring(0, 10) + "...",
    isHex: transaction_data.startsWith("0x")
  });

  const transactions: MetaTransactionData[] = [{
    to: `0x38A4794cCEd47d3baf7370CcC43B560D3a1beEFA`, // SSV contract address
    value: '0',
    data: transaction_data,
    operation: OperationType.Call
  }];

  console.debug("Creating transaction with:", {
    to: transactions[0].to,
    dataLength: transactions[0].data.length,
    operation: transactions[0].operation
  });

  console.debug("Generating transaction...");
  
  const createTransactionWithRetry = async (): Promise<SafeTransaction> => {
    let safeTransaction = await protocolKit.createTransaction({
      transactions: transactions,
    });

    const isValidTx = await protocolKit.isValidTransaction(
      safeTransaction,
    )

    if (!isValidTx) {
      throw Error("!!!!!!:::: Transaction is invalid");
    }

    return safeTransaction;
  };

  const retryOptions: RetryOptions = {
    retries: 5,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 10000,
    randomize: true,
  };

  let safeTransaction: SafeTransaction;
  try {
    safeTransaction = await retryWithExponentialBackoff<SafeTransaction>(
      createTransactionWithRetry,
      retryOptions
    );
  } catch (error) {
    console.error("Failed to create valid transaction after retries:", error);
    throw error;
  }

  console.debug(`Signatures before: ${JSON.stringify({
    ...safeTransaction,
    data: { ...safeTransaction.data, data: safeTransaction.data.data.substring(0, 5) + '...' }
  })}`);
  console.debug(`Signing transaction...`)

  // Get the transaction hash
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  
  // Get the signer address
  const signerAddress = await protocolKit.getAddress();
  console.debug(`Signer address: ${signerAddress}`);
  
  // Approve the transaction hash
  console.debug("Approving transaction hash...");
  const approveTxResponse = await protocolKit.approveTransactionHash(safeTxHash);
  console.debug(`Approval response: ${approveTxResponse.hash}`);
  const receipt = approveTxResponse.transactionResponse && (await (approveTxResponse.transactionResponse as TransactionResponse).wait())

  
  // Check if the transaction has been approved
  const ownersWhoApproved = await protocolKit.getOwnersWhoApprovedTx(safeTxHash);
  console.debug(`Owners who approved after waiting: ${ownersWhoApproved.join(', ')}`);

  
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

  const receipt = executeTxResponse.transactionResponse && (await (executeTxResponse.transactionResponse as TransactionResponse).wait())

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