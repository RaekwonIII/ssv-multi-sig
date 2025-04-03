# ssv-multi-sig


## Dependencies installation

Install bun by running this command:

```sh
npm install
```
## Usage

To run the tool using the Bun runtime, launch the command:

```bash
npm run start register 1,2,3,4
```

### Environment variables

The various commands need the following environment variables to be set:

```sh
# The URL of an RPC endpoint. Needed for signing transactions
RPC_ENDPOINT=
# private key of an Ethereum wallet. Necessary to sign transactions, and it **must** the the wallet of the `owner`.
PRIVATE_KEY=
# The owner address that will be used to register validators
OWNER_ADDRESS=
# The directory where generated keystores files should be saved to
KEYSTORES_OUTPUT_DIRECTORY=
# The password that should be used to encrypt generated keystores files
KEYSTORE_PASSWORD=
# the address of the multi-sig safe to be used for this script
SAFE_ADDRESS=
# URL of the safe transaction service. Can be left empty to use default (mainnet)
TX_SERVICE= # e.g. https://safe-transaction-mainnet.safe.global/ or https://transaction-holesky.holesky-safe.protofire.io/
```