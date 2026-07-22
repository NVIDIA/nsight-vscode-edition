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

export const languageSupportConfigurationSection = 'nsight.cuda.languageSupport';
export const languageSupportAutoConfigureConfiguration = `${languageSupportConfigurationSection}.autoConfigure`;
export const languageSupportProviderConfiguration = `${languageSupportConfigurationSection}.provider`;

export type LanguageSupportConfigurationTrigger = 'automatic' | 'userRequested';

export function workspaceStateKey(folder: { uri: { toString(): string } }, suffix: string): string {
    return `${languageSupportConfigurationSection}.${suffix}.${folder.uri.toString()}`;
}
