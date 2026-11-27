// Migration SQL files are bundled as strings (`--loader .sql:text` in the build script).
declare module "*.sql" {
	const sql: string;
	export default sql;
}
