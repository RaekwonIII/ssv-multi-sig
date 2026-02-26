# SSV Multi-sig bulk registration script

# Steps to use:

## 1. Clone repo 

``` bash
git clone https://github.com/RaekwonIII/ssv-multi-sig.git
cd ssv-multi-sig
```
## 2. Install dependencies

Install packages by running this command:

```bash
npm install
```

### 3. Set environment variables

Create a .env file in the top level of the directory, you can copy the example file with:

```bash
cp .env.example .env
```

The `register` command needs the following environment variables to be set:

```sh
# The URL of an RPC endpoint. Needed for signing transactions
RPC_ENDPOINT=
# private key of an Ethereum wallet. Necessary to sign transactions, and it **must** the the wallet of the `owner`.
PRIVATE_KEY=
# The address of the SSVNetwork smart contract
SSV_CONTRACT=
# Optional Safe baseGas override. Defaults to 50000 if not set.
SAFE_BASE_GAS=
# Optional deposit amount in ETH used for validator registration. Defaults to 0.1 if not set.
DEPOSIT_AMOUNT_ETH=
# The password that should be used to encrypt generated keystores files
KEYSTORE_PASSWORD=
# the address of the multi-sig safe to be used for this script. This will effectively be the validator owner on SSV network
SAFE_ADDRESS=
# URL of the subgraph API which is chain dependent 
SUBGRAPH_API= # e.g. https://gateway.thegraph.com/api/subgraphs/id/7V45fKPugp9psQjgrGsfif98gWzCyC6ChN7CW98VyQnr for SSV Network mainnet
# The API key to be used for requests to the subgraph endpoint
SUBGRAPH_API_KEY= # generate your API key **for free** here: https://thegraph.com/studio/apikeys/
```

## 4. Create and register validators

To run the tool, launch the command:

```bash
npm run start register <operatorIDs>
```

The `<operatorIDs>` argument is a comma-separated list of numbers (i.e. `1,2,3,4`), representing the operator IDs that will form the cluster to which validators will be registered.

An additional argument is `-n, --num-keys <num-keys>` which configures the script to generate "a maximum of" keys equal to the provided number. The script verifies if this is possible, depending on the number of validators already registered to operators (calculating the "validator cap": maximum number of validators per operators, minus validators already registered), and generates/registers a number of keys equal to the smallest between the provided number and the available "validator cap".

You can also use `-k, --keystoresDir <keystores-dir>` to load existing keystore JSON files from a directory instead of generating new ones. When this option is used, the script registers all compatible `keystore*` files found in that directory (sorted deterministically by validator index when possible).

### Usage examples

Generate and register up to 50 new validators:

```bash
npm run start register 1,2,3,4 -n 50
```

Register validators from existing keystores in `./validator_keys`:

```bash
npm run start register 1,2,3,4 -k ./validator_keys
```

## 5. Resume behavior (`-k` mode)

When you run with `-k, --keystoresDir`, the script writes progress to:

```text
<keystoresDir>/.ssv-register-progress.json
```

Progress is tracked per batch (`prepared` -> `approved` -> `executed`) and includes the next key index to process. If the process stops, re-running with the same command/options will resume from the key after the last successfully executed batch.

### Strict resume mode

Resume is strict by default. On restart, the script compares the on-chain owner nonce with the local progress file.

- If nonce changes match tracked pending batches, it auto-reconciles and continues.
- If nonce drift cannot be explained by tracked batches, the script aborts to avoid skipping or duplicating registrations.

### Recovery steps for strict-mode failures

1. Verify you are using exactly the same inputs as the interrupted run:
   - same `-k` directory
   - same operator IDs
   - same environment (`SAFE_ADDRESS`, `SSV_CONTRACT`, chain/RPC)
2. Inspect `<keystoresDir>/.ssv-register-progress.json` and identify the last batch status and `nextIndex`.
3. Check owner nonce on-chain for `SAFE_ADDRESS` and compare it to `lastKnownOwnerNonce` in the progress file.
4. If external transactions changed owner nonce (outside this script), stop and decide one of:
   - use a dedicated Safe owner/nonce lane for this workflow, then retry
   - manually reconcile and update the progress file only if you are certain which keys were registered
5. Re-run the same command once nonce/progress are consistent.

If you are unsure during manual reconciliation, do not guess: verify transactions and registered validator keys first, then update progress.
