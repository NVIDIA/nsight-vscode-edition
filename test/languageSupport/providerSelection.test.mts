import { selectLanguageProvider } from '../../src/languageSupport/providerSelection.ts';
import { installedLanguageProvidersEqual, type InstalledLanguageProviders, type LanguageProvider, languageProviderIds } from '../../src/languageSupport/providers.ts';

function installedProviders(installedProviderIds: LanguageProvider[]): InstalledLanguageProviders {
    const providers = {} as InstalledLanguageProviders;

    for (const provider of languageProviderIds) {
        providers[provider] = installedProviderIds.includes(provider);
    }

    return providers;
}

describe('CUDA language provider selection', () => {
    test('covers explicit, disabled, auto, and host-specific provider decisions', () => {
        expect(installedLanguageProvidersEqual(installedProviders(['clangd']), installedProviders(['clangd']))).toBe(true);
        expect(installedLanguageProvidersEqual(installedProviders(['clangd']), installedProviders(['cpptools']))).toBe(false);

        for (const { preference, installed, isMicrosoftVsCode, expected } of [
            {
                preference: 'clangd',
                installed: ['clangd', 'cpptools'],
                isMicrosoftVsCode: true,
                expected: { kind: 'use', provider: 'clangd' }
            },
            {
                preference: 'clangd',
                installed: [],
                isMicrosoftVsCode: true,
                expected: { kind: 'install', provider: 'clangd' }
            },
            {
                preference: 'disabled',
                installed: ['clangd', 'cpptools'],
                isMicrosoftVsCode: true,
                expected: { kind: 'disabled' }
            },
            {
                preference: 'unknown-provider',
                installed: ['cpptools'],
                isMicrosoftVsCode: true,
                expected: { kind: 'use', provider: 'cpptools' }
            },
            {
                preference: 'auto',
                installed: ['clangd', 'cpptools'],
                isMicrosoftVsCode: true,
                expected: { kind: 'use', provider: 'cpptools' }
            },
            {
                preference: 'auto',
                installed: ['clangd', 'cpptools'],
                isMicrosoftVsCode: false,
                expected: { kind: 'use', provider: 'clangd' }
            },
            {
                preference: 'auto',
                installed: ['cpptools'],
                isMicrosoftVsCode: false,
                expected: { kind: 'use', provider: 'cpptools' }
            },
            {
                preference: 'auto',
                installed: [],
                isMicrosoftVsCode: true,
                expected: { kind: 'install', provider: 'cpptools' }
            },
            {
                preference: 'auto',
                installed: [],
                isMicrosoftVsCode: false,
                expected: { kind: 'install', provider: 'clangd' }
            }
        ] as const) {
            expect(
                selectLanguageProvider({
                    preference,
                    installedProviders: installedProviders([...installed]),
                    isMicrosoftVsCode
                })
            ).toEqual(expected);
        }
    });
});
