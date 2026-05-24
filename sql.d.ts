declare module "sql.js" {
	export interface Database {
		run(sql: string, params?: any[]): { changes: number; lastInsertRowid: number };
		exec(sql: string, params?: any[]): any[];
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
