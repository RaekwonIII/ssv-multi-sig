# ssv-etherfi


## Dependencies installation

> This project was created using `bun init` in bun v1.0.11.
> Newer versions of bun, might suffer from [this known issue](https://github.com/oven-sh/bun/issues/267)
> In this case, it is advised to downgrade bun to this specific version `curl -fsSl https://bun.sh/install | bash -s "bun-v1.0.11"` or wait for an incoming fix.

[Bun](https://bun.sh) is a fast all-in-one JavaScript runtime. The best way to use this tool is to install Bun.

To install dependencies:

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
bun index.ts etherfi <PATH_TO_FOLDER_WITH_KEYSHARES_FILES> -o <OPERATOR_ID1>,<OPERATOR_ID2>,<OPERATOR_ID3>,<OPERATOR_ID4>
```

This will iterate over all the `keyshares**.json` files found in the provided `<PATH_TO_FOLDER_WITH_KEYSHARES_FILES>` and all its subfolders and generate a multi-sig transaction (and provide first confirmation) to `bulkRegisterValidator` 40 public keys at a time, using the payload information from the keyshares file(s).

One additional check is performed, by looking at the number of validators in the cluster: if the pubkeys found will cause the operators to exceed the 500 validators mark, it will not consider the exceeding public keys, and report the last filename used.

Finally, when the multi-sig transaction is created (and confirmed), it verifies if the necessary number of confirmations is reached, and in that case, it proceeds to execute it.

At the end of the process, it reports files that included keyshares with issues encountered and filenames containing the keyshares that had issues.

### Environment variables

The various commands need the following environment variables to be set:

```sh
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