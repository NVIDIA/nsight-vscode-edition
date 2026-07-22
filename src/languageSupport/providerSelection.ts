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

import { type InstalledLanguageProviders, type LanguageProvider, languageProviderIds } from './providers';

export type LanguageProviderPreference = LanguageProvider | 'auto' | 'disabled';

export type ProviderSelectionInput = {
    preference: string;
    installedProviders: InstalledLanguageProviders;
    isMicrosoftVsCode: boolean;
};

export type ProviderSelectionDecision =
    | {
          kind: 'disabled';
      }
    | {
          kind: 'use';
          provider: LanguageProvider;
      }
    | {
          kind: 'install';
          provider: LanguageProvider;
      };

function isLanguageProvider(value: string): value is LanguageProvider {
    return languageProviderIds.includes(value as LanguageProvider);
}

export function normalizeLanguageProviderPreference(preference: string): LanguageProviderPreference {
    if (preference === 'auto' || preference === 'disabled' || isLanguageProvider(preference)) {
        return preference;
    }

    return 'auto';
}

function defaultLanguageProvider(isMicrosoftVsCode: boolean): LanguageProvider {
    return isMicrosoftVsCode ? 'cpptools' : 'clangd';
}

export function selectLanguageProvider(input: ProviderSelectionInput): ProviderSelectionDecision {
    const { installedProviders, isMicrosoftVsCode } = input;
    const preference = normalizeLanguageProviderPreference(input.preference);

    if (preference === 'disabled') {
        return { kind: 'disabled' };
    }

    if (isLanguageProvider(preference)) {
        return installedProviders[preference] ? { kind: 'use', provider: preference } : { kind: 'install', provider: preference };
    }

    const installedProviderIds = languageProviderIds.filter((provider) => installedProviders[provider]);

    if (installedProviderIds.length > 0) {
        const defaultProvider = defaultLanguageProvider(isMicrosoftVsCode);
        return { kind: 'use', provider: installedProviders[defaultProvider] ? defaultProvider : installedProviderIds[0] };
    }

    return { kind: 'install', provider: defaultLanguageProvider(isMicrosoftVsCode) };
}
