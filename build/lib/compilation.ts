/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as gulp from 'gulp';
import * as tsb from 'gulp-tsb';
import * as es from 'event-stream';
const watch = require('./watch');
import * as nls from './nls';
import * as util from './util';
import { createReporter } from './reporter';
import * as path from 'path';
import * as bom from 'gulp-bom';
import * as sourcemaps from 'gulp-sourcemaps';
import * as _ from 'underscore';
import * as monacodts from '../monaco/api';
import * as fs from 'fs';

const reporter = createReporter();

function getTypeScriptCompilerOptions(src: string) {
	const rootDir = path.join(__dirname, `../../${src}`);
	const options = require(`../../${src}/tsconfig.json`).compilerOptions;
	options.verbose = false;
	options.sourceMap = true;
	if (process.env['VSCODE_NO_SOURCEMAP']) { // To be used by developers in a hurry
		options.sourceMap = false;
	}
	options.rootDir = rootDir;
	options.baseUrl = rootDir;
	options.sourceRoot = util.toFileUri(rootDir);
	options.newLine = /\r\n/.test(fs.readFileSync(__filename, 'utf8')) ? 'CRLF' : 'LF';
	return options;
}

function createCompile(src: string, build: boolean, emitError?: boolean): (token?: util.ICancellationToken) => NodeJS.ReadWriteStream {
	const opts = _.clone(getTypeScriptCompilerOptions(src));
	opts.inlineSources = !!build;
	opts.noFilesystemLookup = true;

	const ts = tsb.create(opts, true, null, err => reporter(err.toString()));

	return function (token?: util.ICancellationToken) {

		const utf8Filter = util.filter(data => /(\/|\\)test(\/|\\).*utf8/.test(data.path));
		const tsFilter = util.filter(data => /\.ts$/.test(data.path));
		const noDeclarationsFilter = util.filter(data => !(/\.d\.ts$/.test(data.path)));

		const input = es.through();
		const output = input
			.pipe(utf8Filter)
			.pipe(bom())
			.pipe(utf8Filter.restore)
			.pipe(tsFilter)
			.pipe(util.loadSourcemaps())
			.pipe(ts(token))
			.pipe(noDeclarationsFilter)
			.pipe(build ? nls() : es.through())
			.pipe(noDeclarationsFilter.restore)
			.pipe(sourcemaps.write('.', {
				addComment: false,
				includeContent: !!build,
				sourceRoot: opts.sourceRoot
			}))
			.pipe(tsFilter.restore)
			.pipe(reporter.end(emitError));

		return es.duplex(input, output);
	};
}

const libDtsGlob = 'node_modules/typescript/lib/*.d.ts';

export function compileTask(src: string, out: string, build: boolean): () => NodeJS.ReadWriteStream {

	return function () {
		const compile = createCompile(src, build, true);

		const srcPipe = es.merge(
			gulp.src(`${src}/**`, { base: `${src}` }),
			gulp.src(libDtsGlob),
		);

		// Do not write .d.ts files to disk, as they are not needed there.
		const dtsFilter = util.filter(data => !/\.d\.ts$/.test(data.path));

		return srcPipe
			.pipe(compile())
			.pipe(dtsFilter)
			.pipe(gulp.dest(out))
			.pipe(dtsFilter.restore)
			.pipe(src !== 'src' ? es.through() : monacodtsTask(out, false));
	};
}

export function watchTask(out: string, build: boolean): () => NodeJS.ReadWriteStream {

	return function () {
		const compile = createCompile('src', build);

		const src = es.merge(
			gulp.src('src/**', { base: 'src' }),
			gulp.src(libDtsGlob),
		);
		const watchSrc = watch('src/**', { base: 'src' });

		// Do not write .d.ts files to disk, as they are not needed there.
		const dtsFilter = util.filter(data => !/\.d\.ts$/.test(data.path));

		return watchSrc
			.pipe(util.incremental(compile, src, true))
			.pipe(dtsFilter)
			.pipe(gulp.dest(out))
			.pipe(dtsFilter.restore)
			.pipe(monacodtsTask(out, true));
	};
}

function monacodtsTask(out: string, isWatch: boolean): NodeJS.ReadWriteStream {

	const basePath = path.resolve(process.cwd(), out);

	const neededFiles: { [file: string]: boolean; } = {};
	monacodts.getFilesToWatch(out).forEach(function (filePath) {
		filePath = path.normalize(filePath);
		neededFiles[filePath] = true;
	});

	const inputFiles: { [file: string]: string; } = {};
	for (let filePath in neededFiles) {
		if (/\bsrc(\/|\\)vs\b/.test(filePath)) {
			// This file is needed from source => simply read it now
			inputFiles[filePath] = fs.readFileSync(filePath).toString();
		}
	}

	const setInputFile = (filePath: string, contents: string) => {
		if (inputFiles[filePath] === contents) {
			// no change
			return;
		}
		inputFiles[filePath] = contents;
		const neededInputFilesCount = Object.keys(neededFiles).length;
		const availableInputFilesCount = Object.keys(inputFiles).length;
		if (neededInputFilesCount === availableInputFilesCount) {
			run();
		}
	};

	const run = () => {
		const result = monacodts.run(out, inputFiles);
		if (!result.isTheSame) {
			if (isWatch) {
				fs.writeFileSync(result.filePath, result.content);
			} else {
				fs.writeFileSync(result.filePath, result.content);
				resultStream.emit('error', 'monaco.d.ts is no longer up to date. Please run gulp watch and commit the new file.');
			}
		}
	};

	let resultStream: NodeJS.ReadWriteStream;

	if (isWatch) {
		watch('build/monaco/*').pipe(es.through(function () {
			run();
		}));
	}

	resultStream = es.through(function (data) {
		const filePath = path.normalize(path.resolve(basePath, data.relative));
		if (neededFiles[filePath]) {
			setInputFile(filePath, data.contents.toString());
		}
		this.emit('data', data);
	});

	return resultStream;
}
