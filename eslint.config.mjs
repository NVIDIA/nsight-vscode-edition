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

import eslint from '@eslint/js';
import * as tseslint from 'typescript-eslint';
import unicornPlugin from 'eslint-plugin-unicorn';
import prettierConfig from 'eslint-plugin-prettier/recommended';
import * as importPlugin from 'eslint-plugin-import-x';
import promisePlugin from 'eslint-plugin-promise';
import { globalIgnores } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

const config = {
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: {
            ...globals.node
        }
    },
    rules: {
        'no-console': 'off',

        // Handled by @typescript-eslint/no-use-before-define
        'no-use-before-define': 'off',

        // Prefer named exports, regardless of how many exports there are
        'import-x/prefer-default-export': 'off',

        // Allow referencing devDependencies in tests and development scripts
        'import-x/no-extraneous-dependencies': [
            'error',
            {
                devDependencies: ['./*.js', './*.mjs', './*.ts', './*.mts', 'src/test/**/*.ts', 'src/test/**/*.mts', 'test/**/*.ts', 'test/**/*.mts']
            }
        ],

        // Allow property names such as `_foo`.
        // Rationale: this is the de facto convention for accessor-backing properties.
        'no-underscore-dangle': 'off',

        // Allow `return await`.
        // Rationale: explicit `await` makes function part of the callstack, which improves stacktraces.
        'no-return-await': 'off',

        // Allow multiple variables in a single `let` or `var` statement.
        // Rationale: it's exactly like function parameters.
        'one-var': 'off',

        // Do not complain about `let ... = undefined`.
        // Rationale: while a no-op, it is useful to clarify intent.
        'no-undef-init': 'off',

        radix: 'off',

        'import-x/no-named-as-default-member': 'off',

        // Make Prettier settings lint rules.
        'prettier/prettier': ['error'],

        // Allow `null`.
        'unicorn/no-null': 'off',

        // Allow explicit 'return undefined'.
        'unicorn/no-useless-undefined': 'off',

        // Do not complain about if (!x) and if (x != y).
        // Rationale: sometimes negated conditions are more readable.
        'unicorn/no-negated-condition': 'off',

        // Do not complain about (await foo).bar.
        // Rationale: simple one-liners can become less readable when broken up.
        'unicorn/no-await-expression-member': 'off',

        // Allow checking for <0 when doing lookups.
        'unicorn/consistent-existence-index-check': 'off',

        // Allow explicit .length in slices even when redundant.
        'unicorn/no-unnecessary-slice-end': 'off',

        // Allow assert(...)
        'unicorn/consistent-assert': 'off',

        // Allow EventEmitter.
        'unicorn/prefer-event-target': 'off',

        // Allow camelCase in addition to kebab-case
        'unicorn/filename-case': [
            'error',
            {
                cases: {
                    camelCase: true,
                    kebabCase: true
                }
            }
        ],

        'unicorn/prefer-trim-start-end': 'off',

        // Allow abbreviations (judiciously)
        'unicorn/prevent-abbreviations': 0,

        // Prefer specifying return types, but don't require it for inline expressions
        '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],

        // Similar to 'no-use-before-define' above but disallowing using typedefs before they are declared
        '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: false, variables: true, typedefs: true }],

        '@typescript-eslint/no-explicit-any': 'off',

        // Allow unused function arguments
        '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],

        // There are many cases where the value is definitely defined, but TypeScript
        // cannot verify it, so occasional use of non-null assertion is necessary.
        '@typescript-eslint/no-non-null-assertion': 'off'
    }
};

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.strict,
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    unicornPlugin.configs.recommended,
    promisePlugin.configs['flat/recommended'],
    prettierConfig,
    config,
    globalIgnores([
        //
        'cdt-gdb-adapter',
        'dist',
        'coverage',
        'node_modules',
        'out',
        'test/projects'
    ])
);
