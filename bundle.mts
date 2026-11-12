#!/usr/bin/env node

import * as assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
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
    },
    warpInfo: {
        entryPoints: ['src/webviews/warpInfo/frontend/main.tsx'],
        outfile: 'dist/webviews/warpInfo/main.js',
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        external: []
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
        vscode = false,
        production = false;
    while (args.length > 0) {
        const arg = args.shift() ?? '';
        if (arg == '--watch') {
            watch = true;
        } else if (arg == '--vscode') {
            vscode = true;
        } else if (arg == '--production') {
            production = true;
        } else if (arg in targetBuildOptions) {
            targets.push(arg as TargetName);
        } else {
            assert.fail(`Invalid argument: ${arg}`);
        }
    }

    assert.ok(targets.length > 0, 'At least one target must be specified.');

    const building = new Set(targets);
    if (vscode) console.log('<build>');
    for (const target of targets) {
        const buildOptions = getBuildOptions(target);
        if (target === 'warpInfo') {
            buildOptions.define = {
                'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development')
            };
            buildOptions.minify = production;
            buildOptions.sourcemap = production ? false : 'linked';
            if (production) {
                const output = path.resolve(buildOptions.absWorkingDir!, buildOptions.outfile!);
                await rm(`${output}.map`, { force: true });
                await rm(output.replace(/\.js$/, '.css.map'), { force: true });
            }
        }
        if (vscode) {
            // When running as VSCode background task, we need to output errors in a format that
            // the corresponding problem matcher in .vscode/tasks.json can parse.
            buildOptions.logLevel = 'silent';
            buildOptions.plugins?.push({
                name: 'esbuild-problem-matcher',
                setup(build: esbuild.PluginBuild) {
                    build.onStart(() => {
                        if (building.size === 0) console.log('<build>');
                        building.add(target);
                    });
                    build.onEnd((result) => {
                        for (const { text, location } of result.errors) {
                            const loc =
                                location === null
                                    ? ''
                                    : `${location.file}:${location.line}:${location.column}: `;
                            console.error(`${loc}error: ${text}`);
                        }
                        building.delete(target);
                        if (building.size === 0) console.log('</build>');
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
