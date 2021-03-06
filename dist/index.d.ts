import { IRollupContext } from "./context";
import { ICode } from "./tscache";
import { IRollupOptions } from "./irollup-options";
import { IOptions } from "./ioptions";
import { Partial } from "./partial";
export default function typescript(options?: Partial<IOptions>): {
    options(config: IRollupOptions): void;
    resolveId(importee: string, importer: string): string | null;
    load(id: string): string | undefined;
    transform(this: IRollupContext, code: string, id: string): ICode | undefined;
    ongenerate(bundleOptions: any): void;
    onwrite({dest}: IRollupOptions): void;
};
