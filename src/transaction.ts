import {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from "@safe-global/safe-core-sdk-types";

import SafeApiKit from "@safe-global/api-kit";

import Safe from "@safe-global/protocol-kit";
import { TransactionResponse } from "ethers";
import * as fs from 'fs';
import * as path from 'path';

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
  console.log("Creating transaction...");

  const transactions: MetaTransactionData[] = [{
    // @ts-ignore
    to: process.env.SSV_CONTRACT, // SSV contract address
    value: '0',
    data: transaction_data,
    operation: OperationType.Call
  }];

  let safeTransaction = await protocolKit.createTransaction({
    transactions: transactions,
  });

  const isValidTx = await protocolKit.isValidTransaction(
    safeTransaction,
  )

  if (!isValidTx) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `invalid-tx-${timestamp}.log`;
      const filepath = path.join(process.cwd(), 'logs', filename);
      
      if (!fs.existsSync(path.join(process.cwd(), 'logs'))) {
        fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
      }
      
      fs.writeFileSync(filepath, transaction_data);
      console.log(`Invalid transaction data logged to: ${filepath}`);
    } catch (error) {
      console.error('Failed to log invalid transaction:', error);
    }
    throw Error("Transaction is invalid");
  }

  // Get the transaction hash
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  
  // Get the signer address
  const signerAddress = await protocolKit.getAddress();
  console.log(`Signing transaction with address: ${signerAddress}`);
  
  // Approve the transaction hash
  const approveTxResponse = await protocolKit.approveTransactionHash(safeTxHash);
  console.log(`Transaction approved: ${approveTxResponse.hash}`);
  
  const receipt = approveTxResponse.transactionResponse && (await (approveTxResponse.transactionResponse as TransactionResponse).wait())
  
  // Check if the transaction has been approved
  const ownersWhoApproved = await protocolKit.getOwnersWhoApprovedTx(safeTxHash);
  console.log(`Owners who approved: ${ownersWhoApproved.join(', ')}`);
  
  return safeTransaction;
}

export async function checkAndExecuteSignatures(
  protocolKit: Safe,
  safeTransaction: SafeTransaction
) {
  console.log("Validating transaction...");
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
  
  try {
    const threshold = await protocolKit.getThreshold();
    const ownersWhoApproved = await protocolKit.getOwnersWhoApprovedTx(safeTxHash);
    const numberOfApprovers = ownersWhoApproved.length;

    if (numberOfApprovers < threshold) {
      throw Error(
        `Approval threshold is ${threshold}, and only ${numberOfApprovers} have been made, transaction ${safeTxHash.substring(0, 5)}... cannot be executed.`
      );
    }

    console.log("Executing transaction...");
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
  } catch (error) {
    console.error(`Error in checkAndExecuteSignatures: ${error}`);
    throw error;
  }
}