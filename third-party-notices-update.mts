#!/usr/bin/env node

import * as fs from 'node:fs';
import path from 'node:path';
import * as licenseChecker from 'license-checker';

const crawlerOverridesFileName = '.crawler-overrides.json';

// This section is intentionally manually maintained. When you update a version number
// please also ensure that you look up any additional files that need to be included
// in our third-party-notices.txt file
const additionalFiles = [
    { name: '@types/vscode', version: '1.101.0', files: [] },
    { name: '@vscode/debugadapter', version: '1.68.0', files: ['thirdpartynotices.txt'] },
    { name: '@vscode/debugprotocol', version: '1.68.0', files: [] },
    { name: 'asn1', version: '0.2.6', files: [] },
    { name: 'bcrypt-pbkdf', version: '1.0.2', files: [] },
    { name: 'buildcheck', version: '0.0.7', files: [] },
    { name: 'cdt-gdb-adapter', version: '0.0.19', files: [] },
    { name: 'cpu-features', version: '0.0.10', files: [] },
    { name: 'isexe', version: '3.1.1', files: [] },
    { name: 'nan', version: '2.26.2', files: [] },
    { name: 'node-addon-api', version: '4.3.0', files: [] },
    { name: 'safer-buffer', version: '2.1.2', files: [] },
    { name: 'semver', version: '7.7.2', files: [] },
    { name: 'ssh-config', version: '4.4.4', files: [] },
    { name: 'ssh2', version: '1.17.0', files: [] },
    { name: 'tweetnacl', version: '0.14.5', files: [] },
    { name: 'which', version: '5.0.0', files: [] }
];

const verbose = process.argv.includes('-v');

function writeError(message: string): void {
    process.stderr.write(message);
}

function writeOutput(message: string): void {
    if (verbose) {
        process.stdout.write(message);
    }
}

function getPackageNameAndVersion(packageName: string): { name: string; version: string } {
    const match = packageName.match(/(.*)@([\d.]*)/);
    return match ? { name: match[1], version: match[2] } : { name: packageName, version: '' };
}

function readJsonFile(filePath: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        writeError(`Failed to read JSON file at ${filePath}: ${(error as Error).message}\n`);
        throw error;
    }
}

async function fetchLicenseContent(licenseFile: string): Promise<string> {
    if (licenseFile.toLowerCase().startsWith('http://') || licenseFile.toLowerCase().startsWith('https://')) {
        const response = await fetch(licenseFile);
        return await response.text();
    } else {
        return fs.readFileSync(licenseFile, 'utf8');
    }
}

function crawlLicenseInformation(workspaceFolder: string, mainPackage: string): Promise<licenseChecker.ModuleInfos> {
    return new Promise((resolve, reject) => {
        licenseChecker.init(
            {
                start: workspaceFolder,
                production: true,
                development: false,
                direct: false,
                unknown: true,
                excludePackages: mainPackage
            },
            (error, moduleInfos) => {
                if (error) {
                    reject(error);
                }
                resolve(moduleInfos);
            }
        );
    });
}

async function updateThirdPartyNotices(workingDirectory: string, outFile: string, verbose: boolean): Promise<void> {
    const packageDefinition = readJsonFile(path.resolve(workingDirectory, 'package.json'));
    writeOutput('Crawling license information...\n');

    const moduleInfos = await crawlLicenseInformation(workingDirectory, `${packageDefinition.name}@${packageDefinition.version}`);
    let generatedContent = `${packageDefinition.displayName} incorporates third-party components listed below:\n`;

    // Used to separate pacakges
    const starSeparator = `\n${'*'.repeat(80)}\n`;

    // Used to separate additional files associated with package information
    const dashSeparator = `\n${'-'.repeat(80)}\n\n`;

    const crawlerOverrides = fs.existsSync(crawlerOverridesFileName) ? readJsonFile(crawlerOverridesFileName) : {};

    const packageNames = Object.keys(moduleInfos);
    writeOutput(`${packageNames.length} packages found.\n`);

    const unaccountedPackages = new Set<string>(additionalFiles.map((config) => config.name)).difference(new Set<string>(packageNames.map((name) => getPackageNameAndVersion(name).name)));
    if (unaccountedPackages.size > 0) {
        writeError(`Expected packages not found by the crawler: ${[...unaccountedPackages].sort().join('\n')}\n`);
        process.exit(1);
    }

    let ok = true;
    for (const packageName of packageNames) {
        const { name: barePackageName, version } = getPackageNameAndVersion(packageName);
        const moduleInfo = moduleInfos[packageName];
        writeOutput(`Processing package: ${packageName}...`);

        if (crawlerOverrides[barePackageName]) {
            Object.assign(moduleInfo, crawlerOverrides[barePackageName]);
        }

        if (moduleInfo['licenses'] === 'UNKNOWN') {
            writeOutput('\n');
            writeError(`License information unknown for package "${packageName}"\n`);
            continue;
        }

        const licenseFile = moduleInfo.licenseFile;
        if (!licenseFile) {
            writeOutput('\n');
            writeError(`No license file found for package "${packageName}"\n`);
            continue;
        }

        const licenseContents = await fetchLicenseContent(licenseFile);
        const headerData = [starSeparator, packageName, `Publisher: ${moduleInfo.publisher}`, `Repository: ${moduleInfo.repository}`, `License: ${moduleInfo.licenses}`, 'License text:', '', ''].join('\n');
        generatedContent += headerData;
        generatedContent += licenseContents;

        // Check for additional files
        const additionalFileConfig = additionalFiles.find((config) => config.name === barePackageName && config.version === version);
        if (additionalFileConfig) {
            for (const file of additionalFileConfig.files) {
                const filePath = path.resolve(workingDirectory, 'node_modules', barePackageName, file);
                if (fs.existsSync(filePath)) {
                    const fileContents = fs.readFileSync(filePath, 'utf8');
                    generatedContent += dashSeparator;
                    generatedContent += fileContents;
                    generatedContent += '\n';
                } else {
                    ok = false;
                    writeOutput('error\n');
                    writeError(`Expected file ${file} not found for package ${barePackageName}@${version}\n`);
                }
            }
        } else {
            ok = false;
            writeOutput('error\n');
            writeError(`Version mismatch or missing additional file configuration for package ${barePackageName}@${version}\n`);
        }

        writeOutput(' done.\n');
    }

    if (!ok) {
        writeError('Some packages had issues during processing. Please check the output above for details.\n');
        process.exit(1);
    }

    // Read existing file content if it exists
    let currentContent = '';
    if (fs.existsSync(outFile)) {
        currentContent = fs.readFileSync(outFile, 'utf8');
    }

    // Write to file only if content has changed
    if (currentContent !== generatedContent) {
        fs.writeFileSync(outFile, generatedContent, 'utf8');
        writeOutput(`Third-party notices updated successfully in '${outFile}'.\n`);
    } else {
        writeOutput(`Third-party notices in '${outFile}' are already up-to-date.\n`);
    }
}

const thirdPartyNoticesPath = path.resolve(import.meta.dirname, 'third-party-notices.txt');
await updateThirdPartyNotices(import.meta.dirname, thirdPartyNoticesPath, verbose);
