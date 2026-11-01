/* 方式2 の入口。NODE_OPTIONS=--require <このファイル> で全プロセスに前置する。
 * dev server がワーカーを分けても、環境変数は継承されるので各プロセスで走る（UR-03）。 */
require('./otel.cjs');
