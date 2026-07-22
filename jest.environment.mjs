/* eslint-disable @typescript-eslint/explicit-function-return-type */

import NodeEnvironment from 'jest-environment-node';
import { Console } from 'node:console';
import fs from 'node:fs';
import path from 'node:path';

const TEST_LOG_BASEDIR = 'out/test/logs';

/** A custom Jest test environment that keeps track of the current test and automatically
 * creates a distinct directory for each test's logs.
 */
export default class RubiconEnvironment extends NodeEnvironment {
    #originalConsole;
    #logStream;

    handleTestEvent(event, state) {
        switch (event.name) {
            case 'test_start': {
                const { test } = event;
                return this.#onTestStart(test);
            }
            case 'test_done': {
                const { test } = event;
                return this.#onTestDone(test);
            }
        }
    }

    #onTestStart(test) {
        const currentTest = [test.name];
        for (let desc = test.parent; desc.parent !== undefined; desc = desc.parent) {
            currentTest.push(desc.name);
        }
        currentTest.reverse();
        this.global.currentTest = currentTest;

        const currentLogPath = path.join(import.meta.dirname, TEST_LOG_BASEDIR, ...currentTest);
        try {
            fs.rmSync(currentLogPath, { recursive: true, force: true });
        } catch (error) {
            console.warn(`Failed to remove pre-existing log directory: ${currentLogPath}`, error);
        }
        fs.mkdirSync(currentLogPath, { recursive: true });
        this.global.currentLogPath = currentLogPath;

        this.#originalConsole = this.global.console;
        this.#logStream = fs.createWriteStream(path.join(currentLogPath, 'console.log'), { flags: 'as' });
        this.global.console = new Console({
            stdout: this.#logStream,
            stderr: this.#logStream,
            colorMode: false
        });
    }

    async #onTestDone(test) {
        this.global.console = this.#originalConsole;
        this.global.currentTest = [];
        this.global.currentLogPath = undefined;
        this.#logStream.end();
    }
}
