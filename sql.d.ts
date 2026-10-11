declare module "sql.js" {
	/** One result set: column names plus rows of SQLite-typed cell values. */
	export interface QueryResult {
		columns: string[];
		values: unknown[][];
	}

	export interface Database {
		run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
		exec(sql: string, params?: unknown[]): QueryResult[];
		export(): Uint8Array;
		close(): void;
	}

	export interface SqlJsStatic {
		Database: new (data?: ArrayLike<number | Buffer>) => Database;
	}

	export default function initSqlJs(config?: {
		locateFile?: (filename: string) => string;
	}): Promise<SqlJsStatic>;
}
