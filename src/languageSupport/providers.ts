/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

export const languageProviderRegistry = {
    clangd: {
        extensionId: 'llvm-vs-code-extensions.vscode-clangd',
        label: 'clangd',
        description: 'Use clangd for CUDA C++ editing'
    },
    cpptools: {
        extensionId: 'ms-vscode.cpptools',
        label: 'Microsoft C/C++',
        description: 'Use Microsoft C/C++ extension for CUDA C++ editing'
    }
} as const;

export type LanguageProvider = keyof typeof languageProviderRegistry;
export type InstalledLanguageProviders = Record<LanguageProvider, boolean>;

export const languageProviderIds = Object.keys(languageProviderRegistry) as LanguageProvider[];

export function installedLanguageProvidersEqual(previous: InstalledLanguageProviders, current: InstalledLanguageProviders): boolean {
    return languageProviderIds.every((provider) => previous[provider] === current[provider]);
}
