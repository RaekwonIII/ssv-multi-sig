# ssv-automate


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

 #### `onboard`

 This sub-command automates validator creation through DKG, their registration, and deposit, given an owner address, as well as a list of operators that need to be included.
 This tool's purpose is to test DKG uptime, and operator performance, by forming clusters where 3 out of 4 operators in it are fixed, and they will always be operators 1, 2, 3 from BloxStaking.

 Usage example:

 ```sh
 bun index.ts onboard 0xaa184b86b4cdb747f4a3bf6e6fcd5e27c1d92c5c -o 4,5
 ```

 This will form two clusters, one with operators `1,2,3,4` and one with operators `1,2,3,5`, both of them belonging to the same owner: `0xaa184b86b4cdb747f4a3bf6e6fcd5e27c1d92c5c`

 #### `ping`

 This sub-command tests the liveliness of DKG server of operators in the provided list.

 Usage example:

 ```sh
 bun index.ts ping  -o 1,2,3,4,202
 ```
This will perform the `ping` command of the DKG tool on operators `1,2,3,4,202` log each result, and report a final summary with a list of operator IDs with DKG issues (either offline, or don't have a DKG endpoint set in their metadata, or are running an older version of the tool)

#### `merge-deposit`

This sub-command is a utility for operators to merge multiple deposit files created in a single DKG ceremony. **Its usage is specific to Simple DVT.**

Typically, the user initiating a "bulk" DKG ceremony, will receive as output a single `keyshares.json` file and a single `deposit_file.json` with all the validators keyshares and public keys created during the ceremony. On the other hand, operators will have multiple files, one for each validator created.

If an operator part of a Simple DVT cluster wants to verify that what has been registered on SSV, is exactly what is about to be submitted to the Lido registry, they can compare the transaction data generated from the deposit file.
They can use this tool, providing one, or multiple transaction hashes of `registerValidator` or `bulkRegisterValidator` and merge multiple `deposit_file.json` for a single validator, in a "bulk" `deposit_file.json` containing all the public keys that are being submitted to the Lido Registry.

Usage example:

```sh
bun index.ts merge-deposit <DKG_OPERATOR_OUTPUT_FOLDER> -t <TX_HASH> -o <OUTPUT_FOLDER>
```

#### `offboard`

 This sub-command automates validator exit from beacon chain through protocol exit messaging, validator removal from SSV network, as well as cluster liquidation.

 This tool's purpose is to clean up an account used for testing, and, given an owner address, it will find **all clusters** from this account, and perform the specified action on **all of them**. At this moment, no filtering is performed on the clusters, except ensuring the correct conditions are met for the given actions (removing validators from `active` clusters, or avoid liquidating `inactive` clusters, because they are already liquidated).

 Usage example:

 ```sh
 bun index.ts offboard 0xaa184b86b4cdb747f4a3bf6e6fcd5e27c1d92c5c exit
 ```

 This will exit validators present in all clusters owned by the specified address.

 > ⚠️ Please note: for now, bulk exits, and bulk removals have not been implemented, so clusters with multiple validators will be ignored, and a warning message will be shown.

### Single-file executable

It is also possible to leverage Bun's ability to bundle a project into a single file, and also compile it into a binary. To do so, launch the command:

```sh
bun build --compile index.ts --outfile=ssv-automate
```

A binary file named `ssv-automate` (you can change the name to your liking in the command above) will be generated in the current directory.

You can then run all the command shown in the previous section, by substituting `bun index.ts` with `./ssv-automate`. For example:

```sh
./ssv-automate ping  -o 1,2,3,4,202
```

### Environment variables

The various commands need the following environment variables to be set:

```sh
# private key of an Ethereum wallet. Necessary for the `automate` command, and it **must** the the wallet of the `owner`
PRIVATE_KEY=
# e.g. "https://api.studio.thegraph.com/query/53804/ssv-holesky/v0.0.1"
SUBGRAPH_API=
# e.g. "output_data"
OUTPUT_FOLDER=
NETWORK=
# e.g. https://api.ssv.network/api/v4/$NETWORK
SSV_API=

# see https://docs.ssv.network/developers/smart-contracts
SSV_CONTRACT=
# see https://docs.ssv.network/developers/smart-contracts#ethereum-deposit-contract-addresses
DEPOSIT_CONTRACT=
RPC_ENDPOINT=
```