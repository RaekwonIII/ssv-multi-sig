#!/usr/bin/env node
import { Command } from 'commander';

import { spinnerError, stopSpinner } from "./src/spinner";
import { onboard } from "./src/commands/onboard";
import { ping } from "./src/commands/ping-lido-operators"
import { mergeDeposit } from "./src/commands/merge-deposit"
import { offboard } from "./src/commands/offboard"

const program = new Command();
program
.description('A simple demonstrative command line tool to automate tasks such as testing Simple DVT operator onboarding, pinging their DKG node, and merging deposit files')
.version('0.0.1')
.addCommand(offboard)
.addCommand(mergeDeposit)
.addCommand(ping)
.addCommand(onboard);

process.on('unhandledRejection', function (err: Error) { // listen for unhandled promise rejections
    const debug = program.opts().verbose; // is the --verbose flag set?
    if(debug) {
        console.error(err.stack); // print the stack trace if we're in verbose mode
    }
    spinnerError() // show an error spinner
    stopSpinner() // stop the spinner
    program.error('', { exitCode: 1 }); // exit with error code 1
})

async function main() {
    await program.parseAsync();

}
console.log() // log a new line so there is a nice space
main();
