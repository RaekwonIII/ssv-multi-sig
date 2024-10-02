import { Command } from "commander";

import {
  debug,
  ShareObject,
} from "../utils";
import { areKeysharesValid } from "../ssv-keys";
import { getOwnerNonceAtBlock, getValidatorRegistrationData } from "../subgraph";

export const validity = new Command("validity");

console.debug = debug;

validity
  .version("0.0.1", "-v, --vers", "output the current version")
  .argument("<txhash>", "The validator's public key")
  .action(async (txhash, options) => {

    let validatorRegistrationData = await getValidatorRegistrationData(txhash);

    if (!validatorRegistrationData) throw Error("No validator data found at this transaction hash");

    let { sharesObjArr, blockNumber, ownerAddress } = validatorRegistrationData

    let initialNonce = await getOwnerNonceAtBlock(ownerAddress, blockNumber)

    console.info(`Starting owner nonce ${initialNonce} for owner ${ownerAddress}`);

    console.info("Verifying Keyshares validity");
    try {
      // test keyshares validity
      await areKeysharesValid(sharesObjArr, initialNonce, ownerAddress);
    } catch (error) {
      console.error(
        `Keyshares verification failed for pubkey ${txhash}:\n${error}`
      );
    }
    console.info(`All Keyshares valid`);
  });

  
