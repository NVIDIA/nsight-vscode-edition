/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

'use strict';

const { argv, string } = require('yargs');
const path = require('path');
const del = require('del');
const fse = require('fs-extra');
const through2 = require('through2');
const gulp = require('gulp');
const semver = require('semver');
const shell = require('gulp-shell');
const spawn = require('await-spawn');
const ts = require('gulp-typescript');
const vsce = require('vsce');
const webpack = require('webpack');
const merge = require('webpack-merge');
const webpackDevConfig = require('./webpack.dev');
const webpackProdConfig = require('./webpack.prod');
const webpackConfigForTests = require('./webpack.unit-tests');

const exportOptions = ['Public', 'Internal', 'NDA'];
const configOptions = ['Release', 'Debug'];

const testProgramsBase = 'src/test/testPrograms/';
const testPrograms = testProgramsBase + '**/Makefile';

const debugAdapterRelPath = './src/debugger/cudaGdbAdapter.ts';
const debugAdapterWebpack = 'cudaGdbAdapter.webpack.js';
const webpackTestExtension = '.webpack.test.js';
const testSourceExtension = '.test.ts';

const webpackOutputPath = path.resolve(__dirname, 'dist/');
const licenseFileName = 'LICENSE';
const thirdPartyNoticesFileName = 'third-party-notices.txt';
const webpackLicenseFile = 'extension.js.LICENSE.txt';

// prettier-ignore
function defineTask({
    displayName = '',
    description = '',
    flags = {},
    task = () => {}
    } = {}) {

    const taskFunc = task;
    taskFunc.displayName = displayName;
    taskFunc.description = description;
    taskFunc.flags = flags;

    return taskFunc;
}

const webpackTest = (callback, testSource, webpackOutput) => {
    const mergedConfig = merge.merge(webpackConfigForTests, {
        entry: testSource,
        output: {
            filename: webpackOutput
        }
    });

    webpack(mergedConfig, (error, stats) => {
        if (error) {
            callback(error);
            return;
        }

        console.log(
            stats.toString({
                chunks: false,
                colors: true
            })
        );

        if (stats.hasErrors() || stats.hasWarnings()) {
            const err = new Error('Errors/warnings present after compiling for webpack.');
            callback(err);
        } else {
            callback();
        }
    });
};

const getWebpackEntryForTest = (file) => {
    return './' + path.relative(__dirname, file);
};

const getWebpackNameForTest = (file) => path.basename(file, testSourceExtension) + webpackTestExtension;

const webpackDebugAdapter = defineTask({
    displayName: 'webpack:dbg-adapter',
    task: (callback) => webpackTest(callback, debugAdapterRelPath, debugAdapterWebpack)
});

const webpackUnitTest = defineTask({
    displayName: 'webpack:unit-test',
    flags: {
        '[--base]': typeof string,
        '[--name]': typeof string
    },
    task: (callback) => {
        const base = argv.base || './src/test/';

        const sourcePath = path.resolve(base, argv.name);
        const entry = getWebpackEntryForTest(sourcePath);
        const outputName = getWebpackNameForTest(sourcePath);

        webpackTest(callback, entry, outputName);
    }
});

const _webpackUnitTests = defineTask({
    displayName: 'webpack:unit-tests',
    task: () => {
        // prettier-ignore
        return gulp
            .src('./src/test/**/*.test.ts', {buffer: false})
            .pipe(through2.obj((file, _, callback) => {
                webpackTest(
                    callback,
                    getWebpackEntryForTest(file.path),
                    getWebpackNameForTest(file.path)
                );
            }));
    }
});

const webpackTests = defineTask({
    displayName: 'webpack:tests',
    description: 'Webpack unit tests',
    task: gulp.parallel(webpackDebugAdapter, _webpackUnitTests)
});

const compileTestPrograms = defineTask({
    displayName: 'compile:test-programs',
    description: 'Compile all test programs',
    task: () => {
        // prettier-ignore
        return gulp
            .src(testPrograms)
            .pipe(shell('cd <%= file.dirname %> && make dbg=1'));
    }
});

const compileTests = defineTask({
    displayName: 'compile:tests',
    description: 'Compile unit tests and test programs',
    task: gulp.parallel(webpackTests, compileTestPrograms)
});

const _cleanUnitTests = defineTask({
    displayName: 'clean:unit-tests',
    task: () => {
        return del(['out/testWebpacks']);
    }
});

const _cleanTestPrograms = defineTask({
    displayName: 'clean:test-programs',
    task: () => {
        // prettier-ignore
        return gulp
            .src(testPrograms)
            .pipe(shell('cd <%= file.dirname %> && make clean'));
    }
});

const cleanTests = defineTask({
    displayName: 'clean:tests',
    description: 'Delete all test program build artifacts',
    task: gulp.parallel(_cleanUnitTests, _cleanTestPrograms)
});

const recompileTests = defineTask({
    displayName: 'test:recompile',
    description: 'Delete all test artifacts and recompile the tests',
    task: gulp.series(cleanTests, compileTests)
});

const _webpack = (callback, webpackProdConfig) => {
    return new Promise((resolve, reject) => {
        webpack(webpackProdConfig, (error, stats) => {
            if (error) {
                callback(error);
                reject(error);
                return;
            }

            console.log(
                stats.toString({
                    chunks: false,
                    colors: true
                })
            );

            if (stats.hasErrors() || stats.hasWarnings()) {
                const err = new Error('Errors/warnings present after compiling for webpack.');
                callback(err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

const _cleanWebpack = defineTask({
    displayName: 'clean:webpack',
    description: 'Clean artifacts generated by webpack',
    task: () => {
        return del(['dist']);
    }
});

function _validatePackageArgs(exportOption, configOption, callback) {
    if (!exportOptions.includes(exportOption)) {
        const exportOptionsStr = exportOptions.join(', ');
        callback(new Error(`Invalid export option '${exportOptionsStr}', correct values are '${exportOptionsStr}'`));
    }

    if (!configOptions.includes(configOption)) {
        const configOptionsStr = configOptions.join(', ');
        callback(new Error(`Invalid config option '${configOption}', correct values are '${configOptionsStr}'`));
    }
}

function _getDayOfYear(date) {
    const startDate = date || new Date();
    const startDateUtc = Date.UTC(startDate);

    const firstDate = new Date(startDate.getFullYear(), 0, 1);
    const firstDateUtc = Date.UTC(firstDate);

    const msInDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor((startDate - firstDate) / msInDay);

    return dayOfYear;
}

function _updateVersion(packageJson, patchNumber, callback) {
    const version = semver.parse(packageJson.version);
    if (!version) {
        callback(new Error(`Version '${packageJson.version}' is not in a correct format`));
    }

    const newVersion = `${version.major}.${version.minor}.${patchNumber}`;
    packageJson.version = newVersion;
}

const compile = defineTask({
    displayName: 'compile',
    description: 'Package extension into a deployable .vsix',
    task: (callback) => _webpack(callback, webpackDevConfig)
});

const packageVsix = defineTask({
    displayName: 'package',
    description: 'Package extension into a deployable .vsix',
    flags: {
        '[--exportLevel]': exportOptions.join('| '),
        '[--config]': configOptions.join(' | '),
        '[--changelist]': 'The current P4 changelist number'
    },
    task: async (callback) => {
        const exportOption = argv.exportLevel || 'Public';
        const configOption = argv.config || 'Release';
        const patchNumber = argv.changelist || _getDayOfYear();

        _validatePackageArgs(exportOption, configOption, callback);

        // Update patch number in package.json for .vsix package,then revert
        // to original version

        try {
            await fse.copy('package.json', '__package.json');
            await fse.chmod('package.json', 0o666);

            const packageJson = await fse.readJson('package.json');
            _updateVersion(packageJson, patchNumber, callback);
            await fse.writeJson('package.json', packageJson, { spaces: 4 });

            await _webpack(callback, webpackProdConfig);

            const licenseFilePath = path.resolve(__dirname, licenseFileName);
            const thirdPartyNoticesFilePath = path.resolve(__dirname, thirdPartyNoticesFileName);

            fse.removeSync(path.resolve(webpackOutputPath, webpackLicenseFile));
            fse.copyFileSync(licenseFilePath, path.resolve(webpackOutputPath, licenseFileName));
            fse.copyFileSync(thirdPartyNoticesFilePath, path.resolve(webpackOutputPath, thirdPartyNoticesFileName));

            const vsixFileName = `${packageJson.name}-${packageJson.version}.vsix`;
            await vsce.createVSIX({
                packagePath: vsixFileName
            });

            const zipFileName = `Rubicon-${exportOption}-${configOption}.zip`;
            await spawn('zip', [zipFileName, vsixFileName]);
        } finally {
            await fse.move('__package.json', 'package.json', { overwrite: true });
        }
    }
});

const _cleanPackage = defineTask({
    displayName: 'clean:package',
    task: () => {
        return del(['*.vsix', 'Rubicon*.zip']);
    }
});

const _cleanOutput = defineTask({
    displayName: 'clean:out',
    description: 'Delete all files under out/',
    task: () => {
        return del(['out']);
    }
});

const clean = defineTask({
    displayName: 'clean',
    description: 'Delete all build/test/publish artifacts',
    task: gulp.parallel(gulp.series(cleanTests, _cleanOutput), _cleanWebpack, _cleanPackage)
});

module.exports = {
    clean,
    cleanTests,
    compile,
    compileTestPrograms,
    compileTests,
    packageVsix,
    recompileTests,
    webpackDebugAdapter,
    webpackTests,
    webpackUnitTest
};
