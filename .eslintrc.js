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

module.exports = {
    parserOptions: {
        ecmaVersion: 6,
        project: ['./tsconfig.json'],
        sourceType: 'module',
        tsconfigRootDir: __dirname
    },
    settings: {
        // Resolve warning (https://github.com/yannickcr/eslint-plugin-react/issues/1955)
        react: {
            version: 'latest'
        }
    },
    plugins: ['@typescript-eslint', 'eslint-comments', 'prettier', 'promise', 'unicorn'],
    extends: ['airbnb-typescript', 'plugin:@typescript-eslint/recommended', 'plugin:eslint-comments/recommended', 'plugin:promise/recommended', 'plugin:unicorn/recommended', 'prettier', 'prettier/@typescript-eslint'],
    rules: {
        // TODO: Temporary during early development, re-enable this once we have logging
        'no-console': 'off',

        // Allow function declaration hoisting
        'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],

        // Prefer named exports, regardless of how many exports there are
        'import/prefer-default-export': 'off',

        // Reinforces preferences for named exports
        'import/no-default-export': 'error',

        // Allow referencing devDependencies in tests
        'import/no-extraneous-dependencies': ['error', { devDependencies: ['**/*.ts', '**/runTest.ts'] }],

        radix: 'off',

        // Make Prettier settings lint rules
        // 'prettier/prettier': ['error'],

        // Prefer specifying return types, but don't require it for inline expressions
        '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],

        // Similar to 'no-use-before-define' above but disallowing using typedefs before they are declared
        '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: true, variables: true, typedefs: true }],

        '@typescript-eslint/no-explicit-any': 'off',

        // Default is 'kebab-case' but we prefer camel-case
        'unicorn/filename-case': [
            'error',
            {
                case: 'camelCase'
            }
        ],

        'unicorn/prefer-trim-start-end': 'off',

        // Allow abbreviations (judiciously)
        'unicorn/prevent-abbreviations': 0
    }
};
