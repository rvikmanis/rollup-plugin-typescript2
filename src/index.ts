import { RollupContext } from "./rollupcontext";
import { ConsoleContext, IRollupContext, VerbosityLevel } from "./context";
import { LanguageServiceHost } from "./host";
import { TsCache, convertDiagnostic, ICode } from "./tscache";
import { createLanguageService, version, createDocumentRegistry, OutputFile, ParsedCommandLine, sys, LanguageService, nodeModuleNameResolver } from "typescript";
import * as resolve from "resolve";
import {defaults, endsWith, concat, find, isFunction, get, each} from "lodash";
import { IRollupOptions } from "./irollup-options";
import { IOptions } from "./ioptions";
import { Partial } from "./partial";
import { parseTsConfig } from "./parse-ts-config";
import { printDiagnostics } from "./print-diagnostics";
import { TSLIB, tslibSource } from "./tslib";
import { blue, red, yellow } from "colors/safe";
import { join, relative, dirname, isAbsolute } from "path";

export default function typescript(options?: Partial<IOptions>)
{
	// tslint:disable-next-line:no-var-requires
	const createFilter = require("rollup-pluginutils").createFilter;
	// tslint:enable-next-line:no-var-requires
	let watchMode = false;
	let round = 0;
	let targetCount = 0;
	let rollupOptions: IRollupOptions;
	let context: ConsoleContext;
	let filter: any;
	let parsedConfig: ParsedCommandLine;
	let servicesHost: LanguageServiceHost;
	let service: LanguageService;
	let noErrors = true;
	const declarations: { [name: string]: OutputFile } = {};

	let _cache: TsCache;
	const cache = (): TsCache =>
	{
		if (!_cache)
			_cache = new TsCache(servicesHost, pluginOptions.cacheRoot, parsedConfig.options, rollupOptions, parsedConfig.fileNames, context);
		return _cache;
	};
	const pluginOptions = { ... options } as IOptions;

	defaults(pluginOptions,
	{
		check: true,
		verbosity: VerbosityLevel.Warning,
		clean: false,
		cacheRoot: `${process.cwd()}/.rpt2_cache`,
		include: [ "*.ts+(|x)", "**/*.ts+(|x)" ],
		exclude: [ "*.d.ts", "**/*.d.ts" ],
		abortOnError: true,
		rollupCommonJSResolveHack: false,
		tsconfig: "tsconfig.json",
		useTsconfigDeclarationDir: false,
	});

	return {

		options(config: IRollupOptions)
		{
			rollupOptions = config;
			context = new ConsoleContext(pluginOptions.verbosity, "rpt2: ");

			context.info(`Typescript version: ${version}`);
			context.debug(`Plugin Options: ${JSON.stringify(pluginOptions, undefined, 4)}`);

			filter = createFilter(pluginOptions.include, pluginOptions.exclude);

			parsedConfig = parseTsConfig(pluginOptions.tsconfig, context, pluginOptions);

			servicesHost = new LanguageServiceHost(parsedConfig);

			service = createLanguageService(servicesHost, createDocumentRegistry());

			// printing compiler option errors
			if (pluginOptions.check)
				printDiagnostics(context, convertDiagnostic("options", service.getCompilerOptionsDiagnostics()));

			context.debug(`rollupConfig: ${JSON.stringify(rollupOptions, undefined, 4)}`);

			if (pluginOptions.clean)
				cache().clean();
		},

		resolveId(importee: string, importer: string)
		{
			if (importee === TSLIB)
				return "\0" + TSLIB;

			if (!importer)
				return null;

			importer = importer.split("\\").join("/");

			// TODO: use module resolution cache
			const result = nodeModuleNameResolver(importee, importer, parsedConfig.options, sys);

			if (result.resolvedModule && result.resolvedModule.resolvedFileName)
			{
				if (filter(result.resolvedModule.resolvedFileName))
					cache().setDependency(result.resolvedModule.resolvedFileName, importer);

				if (endsWith(result.resolvedModule.resolvedFileName, ".d.ts"))
					return null;

				const resolved = pluginOptions.rollupCommonJSResolveHack
					? resolve.sync(result.resolvedModule.resolvedFileName)
					: result.resolvedModule.resolvedFileName;

				context.debug(`${blue("resolving")} '${importee}'`);
				context.debug(`    to '${resolved}'`);

				return resolved;
			}

			return null;
		},

		load(id: string): string | undefined
		{
			if (id === "\0" + TSLIB)
				return tslibSource;

			return undefined;
		},

		transform(this: IRollupContext, code: string, id: string): ICode | undefined
		{
			if (!filter(id))
				return undefined;

			const contextWrapper = new RollupContext(pluginOptions.verbosity, pluginOptions.abortOnError, this, "rpt2: ");

			const snapshot = servicesHost.setSnapshot(id, code);

			// getting compiled file from cache or from ts
			const result = cache().getCompiled(id, snapshot, () =>
			{
				const output = service.getEmitOutput(id);

				if (output.emitSkipped)
				{
					noErrors = false;

					// always checking on fatal errors, even if options.check is set to false
					const diagnostics = concat(
						cache().getSyntacticDiagnostics(id, snapshot, () =>
						{
							return service.getSyntacticDiagnostics(id);
						}),
						cache().getSemanticDiagnostics(id, snapshot, () =>
						{
							return service.getSemanticDiagnostics(id);
						}),
					);
					printDiagnostics(contextWrapper, diagnostics);

					// since no output was generated, aborting compilation
					cache().done();
					if (isFunction(this.error))
						this.error(red(`failed to transpile '${id}'`));
				}

				const transpiled = find(output.outputFiles, (entry) => endsWith(entry.name, ".js") || endsWith(entry.name, ".jsx"));
				const map = find(output.outputFiles, (entry) => endsWith(entry.name, ".map"));
				const dts = find(output.outputFiles, (entry) => endsWith(entry.name, ".d.ts"));

				return {
					code: transpiled ? transpiled.text : undefined,
					map: map ? JSON.parse(map.text) : { mappings: "" },
					dts,
				};
			});

			if (pluginOptions.check)
			{
				const diagnostics = concat(
					cache().getSyntacticDiagnostics(id, snapshot, () =>
					{
						return service.getSyntacticDiagnostics(id);
					}),
					cache().getSemanticDiagnostics(id, snapshot, () =>
					{
						return service.getSemanticDiagnostics(id);
					}),
				);

				if (diagnostics.length > 0)
					noErrors = false;

				printDiagnostics(contextWrapper, diagnostics);
			}

			if (result && result.dts)
			{
				declarations[result.dts.name] = result.dts;
				result.dts = undefined;
			}

			return result;
		},

		ongenerate(bundleOptions: any): void
		{
			targetCount = get(bundleOptions, "targets.length", 1);

			if (round >= targetCount) // ongenerate() is called for each target
			{
				watchMode = true;
				round = 0;
			}
			context.debug(`generating target ${round + 1} of ${targetCount}`);

			if (watchMode && round === 0)
			{
				context.debug("running in watch mode");

				cache().walkTree((id) =>
				{
					const diagnostics = concat(
						convertDiagnostic("syntax", service.getSyntacticDiagnostics(id)),
						convertDiagnostic("semantic", service.getSemanticDiagnostics(id)),
					);

					printDiagnostics(context, diagnostics);
				});
			}

			if (!watchMode && !noErrors)
				context.info(yellow("there were errors or warnings above."));

			cache().done();

			round++;
		},

		onwrite({dest}: IRollupOptions)
		{
			const baseDeclarationDir = parsedConfig.options.outDir;
			each(declarations, ({ name, text, writeByteOrderMark }) =>
			{
				let writeToPath: string;
				// If for some reason no 'dest' property exists or if 'useTsconfigDeclarationDir' is given in the plugin options,
				// use the path provided by Typescript's LanguageService.
				if (!dest || pluginOptions.useTsconfigDeclarationDir)
					writeToPath = name;
				else
				{
					// Otherwise, take the directory name from the path and make sure it is absolute.
					const destDirname = dirname(dest);
					const destDirectory = isAbsolute(dest) ? destDirname : join(process.cwd(), destDirname);
					writeToPath = join(destDirectory, relative(baseDeclarationDir!, name));
				}

				// Write the declaration file to disk.
				sys.writeFile(writeToPath, text, writeByteOrderMark);
			});
		},
	};
}
