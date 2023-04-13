#!/usr/bin/env node

// The contents of this file are a trimmed down version of the (outstanding)
// relative-deps project, that focus on a reduced set of (dev) depenedencies
// with modifications and additions to tailor it to our specific use case.
//
// The relative-deps lives at the following address on GitHub:
//     https://github.com/mweststrate/relative-deps
//
// A link to the LICENSE file for the project is here:
//     https://github.com/mweststrate/relative-deps/blob/master/LICENSE
//
// The contents of the license at the time of this writing are listed below:
//
//                         ------------------------
//
// MIT License
//
// Copyright (c) 2019 Michel Weststrate
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
//                         ------------------------
//
// The contents of this file follow the same (MIT) license described above.


const path = require('path');
const fs = require('fs');
const spawnSync = require('child_process').spawnSync;
const globby = require('globby');
const rimraf = require('rimraf');
const tar = require('tar');

const cgaPackageName = 'cdt-gdb-adapter';
const pathToCGA = path.resolve(process.cwd(), 'cdt-gdb-adapter');

if (!fs.existsSync(pathToCGA)) {
    console.error('cdt-gdb-adapter not found.');
    process.exit(1);
}

// Check to see if there has been any changes requiring a rebuild.

const timestampsFile = path.resolve(process.cwd(), 'node_modules', cgaPackageName, '.prepare_timestamps');
const oldTimestamps = fs.existsSync(timestampsFile) ? fs.readFileSync(timestampsFile, 'utf8') : '';

const files = globby
    .sync(['**/*', '!node_modules', '!.git'], {
        gitignore: true,
        cwd: pathToCGA,
        nodir: true
    })
    .sort();

const mtimes = [];
for (let file of files) mtimes.push(fs.statSync(path.resolve(pathToCGA, file)).mtime.getTime());
const newTimestamps = files.map((file, index) => mtimes[index] + ' ' + file).join('\n');

if (newTimestamps === oldTimestamps) {
    console.log('[prepare] No changes.');
    return;
}

let debugRemoveThisLater = 0;
yarn = (...args) => {
    if (debugRemoveThisLater !== 0) {
        console.log(`args: ${args.join(' ')}`);
        return;
    }
    const result = spawnSync('yarn', args, {
        cwd: pathToCGA,
        args: args,
        stdio: [0, 1, 2]
    });

    if (result.error) throw new Error(`yarn failed with arguments '${command} ${args.join(' ')}'.`);
};

// Run install if never done before
if (!fs.existsSync(path.join(pathToCGA, 'node_modules'))) {
    console.log(`[prepare] Running 'install' in ${pathToCGA}`);
    yarn('install');
}

// Run build script if present
const packageJson = JSON.parse(fs.readFileSync(path.join(pathToCGA, 'package.json'), 'utf8'));
if (packageJson.scripts && packageJson.scripts.build) {
    console.log(`[prepare] Building ${cgaPackageName} in ${pathToCGA}`);
    yarn('run', 'build');
}

// Pack and locally install the package.
const destDir = path.join(process.cwd(), 'node_modules', cgaPackageName);
let pathToTarFile;
try {
    console.log('[prepare] Copying to local node_modules');

    yarn('pack');

    if (fs.existsSync(destDir)) {
        rimraf.sync(destDir);
    }

    fs.mkdirSync(destDir, { recursive: true });

    const packagedName = fs.readdirSync(pathToCGA).find((file) => file.startsWith(cgaPackageName));
    if (!packagedName) {
        console.error('Package tar file not found.');
        process.exit(1);
    }

    pathToTarFile = path.join(pathToCGA, packagedName);

    console.log(`[prepare] Extracting "${pathToTarFile}" to ${destDir}`);

    tar.extract({
        cwd: path.relative(process.cwd(), destDir),
        file: path.relative(process.cwd(), pathToTarFile),
        gzip: true,
        stripComponents: 1,
        sync: true
    });
} finally {
    if (pathToTarFile) {
        fs.unlinkSync(pathToTarFile);
    }
}

fs.writeFileSync(timestampsFile, newTimestamps);
console.log(`[prepare] Done.`);
