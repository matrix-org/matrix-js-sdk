// Based on https://github.com/facebook/jest/issues/4156#issuecomment-757376195
const { DefaultReporter } = require('@jest/reporters');

class Reporter extends DefaultReporter {
    printTestFileHeader(testPath, config, result) {
        const console = result.console;

        if (result.numFailingTests === 0 && !result.testExecError) {
            result.console = null;
        }

        super.printTestFileHeader(testPath, config, result);

        result.console = console;
    }
}

module.exports = Reporter;
