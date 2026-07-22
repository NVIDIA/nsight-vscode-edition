#!/usr/bin/env node

import * as assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { type BuildOptions } from 'esbuild';

const targetBuildOptions = {
    extension: {
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js'
    },
    debugAdapter: {
        entryPoints: ['src/debugger/cudaGdbAdapter.ts'],
        outfile: 'dist/debugAdapter.js'
    }
} satisfies { [key: string]: BuildOptions };

type TargetName = keyof typeof targetBuildOptions;

function getBuildOptions(target: TargetName, options: BuildOptions = {}): BuildOptions {
    return {
        logLevel: 'info',
        absWorkingDir: path.dirname(fileURLToPath(import.meta.url)),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        outbase: 'src',
        sourcemap: 'linked',
        loader: { '.node': 'file' },
        external: ['vscode'],
        plugins: [],
        ...targetBuildOptions[target],
        ...options
    };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    const targets: TargetName[] = [];

    let watch = false,
        vscode = false;
    while (args.length > 0) {
        const arg = args.shift() ?? '';
        if (arg == '--watch') {
            watch = true;
        } else if (arg == '--vscode') {
            vscode = true;
        } else if (arg in targetBuildOptions) {
            targets.push(arg as TargetName);
        } else {
            assert.fail(`Invalid argument: ${arg}`);
        }
    }

    assert.ok(!watch || targets.length === 1, '--watch can only be used with a single target.');
    assert.ok(targets.length > 0, 'At least one target must be specified.');

    for (const target of targets) {
        const buildOptions = getBuildOptions(target);
        if (vscode) {
            // When running as VSCode background task, we need to output errors in a format that
            // the corresponding problem matcher in .vscode/tasks.json can parse.
            buildOptions.logLevel = 'silent';
            buildOptions.plugins?.push({
                name: 'esbuild-problem-matcher',
                setup(build: esbuild.PluginBuild) {
                    build.onStart(() => {
                        console.log('<build>');
                    });
                    build.onEnd((result) => {
                        for (const { text, location } of result.errors) {
                            const loc = location === null ? '' : `${location.file}:${location.line}:${location.column}: `;
                            console.error(`${loc}error: ${text}`);
                        }
                        console.log('</build>');
                    });
                }
            });
        }
        const context = await esbuild.context(buildOptions);
        if (watch) {
            await context.watch();
        } else {
            try {
                await context.rebuild();
            } catch (error) {
                if (error instanceof Error) {
                    if (!vscode) {
                        console.error(error.message);
                    }
                    process.exit(1);
                } else {
                    throw error;
                }
            } finally {
                await context.dispose();
            }
        }
    }
}

await main();
