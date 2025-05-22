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
# The password that should be used to encrypt generated keystores files
KEYSTORE_PASSWORD=
# the address of the multi-sig safe to be used for this script. This will effectively be the validator owner on SSV network
SAFE_ADDRESS=
# URL of the safe transaction service. Can be left empty to use default (mainnet)
TX_SERVICE= # e.g. https://safe-transaction-mainnet.safe.global/ or https://transaction-holesky.holesky-safe.protofire.io/
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

And additional argument is `-n, --num-keys <num-keys>` which configures the script to generate "a maximum of" keys equal to the provided number. The script will verify if this is possible, depending on the number of validators already registered to operators (calculating the "validator cap": maximum number of validators per operators, minus validators already registered), and generate and register a number of keys equal to the smallest between the provided number, and the available "validator cap".