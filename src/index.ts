import { Command } from 'commander';

const program = new Command();
program
.description('A command line tool to register operators to a validator in bulk using a multisig wallet.')
.version('0.0.1')
// .addCommand(etherfi)

process.on('unhandledRejection', function (err: Error) { // listen for unhandled promise rejections
    const debug = program.opts().verbose; // is the --verbose flag set?
    if(debug) {
        console.error(err.stack); // print the stack trace if we're in verbose mode
    }
    program.error('', { exitCode: 1 }); // exit with error code 1
})

async function main() {
    await program.parseAsync();

}
console.log() // log a new line so there is a nice space
main();