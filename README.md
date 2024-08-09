# ssv-etherfi


## Dependencies installation

Install bun by running this command:

```sh
curl -fsSL https://bun.sh/install | bash
```

> This project was created using bun `v1.0.11`.
> Versions newer than `v1.0.11` but older than `v1.1.21`, might suffer from [this known issue](https://github.com/oven-sh/bun/issues/267)
> In this case, either downgrade bun to this specific version `curl -fsSl https://bun.sh/install | bash -s "bun-v1.0.11"` or make sure to upgrade with `bun upgrade`.

To install project dependencies:

```bash
bun install
```

## Usage

To run the tool using the Bun runtime, launch the command:

```bash
bun index.ts --help
```

### Available sub-commands

#### `etherfi`

This sub-command automates validator registration when the owner is a multi-sig.

> ⚠️ Please note: this script was specifically designed for clusters composed of 7 operators, under the assumption that a multi-sig transaction registers validators. This means that the maximum number of validators that can be registered in a single transaction is 40.

Usage example:

```sh
bun index.ts etherfi <PATH_TO_FOLDER_WITH_KEYSHARES_FILES>
```

The script will:

* iterate over all the `keyshares**.json` files found in the provided `<PATH_TO_FOLDER_WITH_KEYSHARES_FILES>` and all its subfolders
* generate a list of keyshare objects in memory, and order the list using the owner `nonce` (ascending)
* verify which validators from the generated list is already registered to the network and ignore them
* verify the minimum validator capacity of the operators set (using first keyshares object, assumption is all keyshares use the same operator set)
  * if the total number of keyshares will bring an operator above the maximum number of validators permitted (500), it will stop at the `Nth` key that will not cause to pass the threshold
* iterate over the list, dividing it in batches, the size of which is dictated by the `CHUNK_SIZE` environment variable. For each batch of keyshares, it will:
  * validate the keyshares, verifying the validity of bls keys (validator pubkey and operator pubkeys), and the validity of the signed message (`${address}:${ownerNonce}`)
  * generate transaction data to `bulkRegisterValidator` 40 public keys at a time, using the payload information from the keyshares file(s), including a deposit of 10 SSV tokens
  * generate a multi-sig transaction (and provide first confirmation) with the transaction data
  * verify if the threshold of signatures is met, and if so, execute the transaction
* then restart the iteration with the next batch

At the end of the process, it reports files that included keyshares with issues encountered and filenames containing the keyshares that had issues.

### Environment variables

The various commands need the following environment variables to be set:

```sh
# Number of keyshares to be processed in a single transaction (default value: 40)
CHUNK_SIZE=
# The URL of an RPC endpoint. Needed for signing transactions
RPC_ENDPOINT=
# private key of an Ethereum wallet. Necessary to sign transactions, and it **must** the the wallet of the `owner`.
PRIVATE_KEY=
# e.g. "https://api.studio.thegraph.com/query/53804/ssv-holesky/v0.0.1"
SUBGRAPH_API=
# see https://docs.ssv.network/developers/smart-contracts
SSV_CONTRACT=
# the address of the multi-sig safe to be used for this script
SAFE_ADDRESS=
# Blockchain network. Available choices: holesky or mainnet
NETWORK= # holesky | mainnet
# URL of the safe transaction service. Can be left empty to use default (mainnet)
TX_SERVICE= # e.g. https://safe-transaction-mainnet.safe.global/ or https://transaction-holesky.holesky-safe.protofire.io/
```