import * as fs from 'node:fs/promises';
import path from 'node:path';
import { languageProviderIds } from '../../src/languageSupport/providers.ts';
import { normalizeCudaGpuArch } from '../../src/languageSupport/cudaEnvironment.ts';

type PackageConfigurationProperty = {
    type?: string;
    default?: unknown;
    enum?: string[];
    pattern?: string;
    scope?: string;
};

type PackageConfigurationProperties = Record<string, PackageConfigurationProperty>;

type PackageJson = {
    activationEvents?: string[];
    files?: string[];
    contributes?: {
        commands?: Array<{ command?: string }>;
        configuration?: {
            properties?: PackageConfigurationProperties;
        };
    };
};

async function readPackageJson(): Promise<PackageJson> {
    const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
    return packageJson;
}

async function readPackageConfigurationProperties(): Promise<PackageConfigurationProperties | undefined> {
    return (await readPackageJson()).contributes?.configuration?.properties;
}

describe('language support package configuration', () => {
    test('keeps language-support settings scoped with expected defaults', async () => {
        const properties = await readPackageConfigurationProperties();
        const providerConfiguration = properties?.['nsight.cuda.languageSupport.provider'];
        const autoConfigureConfiguration = properties?.['nsight.cuda.languageSupport.autoConfigure'];
        const gpuArchConfiguration = properties?.['nsight.cuda.languageSupport.gpuArch'];

        expect(providerConfiguration?.default).toBe('auto');
        expect(providerConfiguration?.scope).toBe('resource');
        expect(providerConfiguration?.enum).toEqual(['auto', ...languageProviderIds]);

        expect(autoConfigureConfiguration).toMatchObject({ type: 'boolean', default: true, scope: 'resource' });
        expect(gpuArchConfiguration).toMatchObject({ type: 'string', default: '', scope: 'resource' });
    });

    test('keeps the gpuArch manifest pattern in sync with normalizeCudaGpuArch', async () => {
        const gpuArchConfiguration = (await readPackageConfigurationProperties())?.['nsight.cuda.languageSupport.gpuArch'];
        const gpuArchPattern = new RegExp(gpuArchConfiguration?.pattern ?? '');

        // The settings-UI gate and the runtime normalizer must agree on what is a
        // valid arch, otherwise a value the UI accepts could still be dropped (or
        // vice versa). Values here are whitespace-free; normalizeCudaGpuArch trims.
        for (const arch of ['', 'sm_75', 'sm_90a', 'compute_90', 'compute_90a', 'sm_100', '90', 'sm_9', 'compute_5', 'sm_1000', 'sm_90b', 'gfx90a', 'sm_']) {
            expect(gpuArchPattern.test(arch)).toBe(arch === '' || normalizeCudaGpuArch(arch) !== undefined);
        }
    });

    test('activates on language support commands', async () => {
        const packageJson = await readPackageJson();
        const contributedCommands = new Set(packageJson.contributes?.commands?.map((command) => command.command));

        for (const command of ['cuda.configureLanguageSupport', 'cuda.generateClangdConfig']) {
            expect(contributedCommands.has(command)).toBe(true);
            expect(packageJson.activationEvents).toContain(`onCommand:${command}`);
        }

        expect(packageJson.activationEvents).toContain('onLanguage:cuda-cpp');
        expect(packageJson.activationEvents).toContain('workspaceContains:**/*.cu');
        expect(packageJson.activationEvents).toContain('workspaceContains:**/*.cuh');
    });

    test('packages the clangd template used by generation commands', async () => {
        const packageJson = await readPackageJson();

        expect(packageJson.files).toContain('templates/clangd/.clangd');
        await expect(fs.access(path.join(process.cwd(), 'templates', 'clangd', '.clangd'))).resolves.toBeUndefined();
    });
});
