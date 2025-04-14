declare module 'retry' {
  export interface RetryOperation {
    attempt(operation: () => void): void;
    retry(error: Error): boolean;
    mainError(): Error;
  }

  export interface RetryOperationOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }

  export function operation(options?: RetryOperationOptions): RetryOperation;
} 