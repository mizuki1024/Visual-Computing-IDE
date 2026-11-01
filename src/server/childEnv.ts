/* =============================================================================
 * 起動先（対象の next dev）に渡す環境変数（Phase 7B-1 で許可リスト方式に変えた）。
 *
 * Phase 7A までは「IDE 自身の実行時の変数を落とす」拒否リストだった。拒否リストでは、
 * IDE のプロセスが持つ**それ以外のすべて**が子に届く。クラウドの環境（Codespaces /
 * Claude Code のリモート環境など）では、IDE のプロセスに次のような秘密情報が入っている
 * ことを実測で確かめた（第2.2節）:
 *   GITHUB_TOKEN / GH_TOKEN / AWS_SECRET_ACCESS_KEY / CLOUDSDK_AUTH_ACCESS_TOKEN /
 *   CLAUDE_CODE_* のトークン / ANTHROPIC_* など
 * 対象の next dev は利用者のプロジェクトのコード（と依存パッケージ）を実行するので、
 * これらを渡す理由が無い。**名前で許可したものだけを渡す。**
 *
 * 対象プロジェクトの秘密情報（DATABASE_URL など）は、Next.js 自身がプロジェクトの
 * `.env*` から読む。IDE が渡す必要は無い。シェルの環境変数に頼るプロジェクトのために、
 * IDE の起動時に `VCIDE_CHILD_ENV_PASS=NAME1,NAME2` で名前を明示すれば渡す
 * （IDE 自身の環境変数であり、画面や API からは変えられない）。
 * ========================================================================== */

/** 名前で許可する変数。OS・ロケール・端末・証明書・Node の解決に要るものだけ */
const ALLOW_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'CI',
  // TLS。社内プロキシなどの証明書の場所（パスであって秘密ではない）
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // Node の版管理・パッケージマネージャの置き場所
  'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'COREPACK_HOME', 'PNPM_HOME', 'NPM_CONFIG_USERCONFIG',
  // 利用者の Node の起動設定。計装はこの後ろに前置する（devServer.ts）
  'NODE_OPTIONS',
  // Windows（未確認の環境だが、無いと node が動かない）
  'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles',
]);

/** 前置きで許可する変数 */
const ALLOW_PREFIX = [/^LC_/];

/**
 * プロキシの設定。**資格情報（user:pass@）を含まないときだけ**渡す。
 * next dev は next/font/google の取得や TypeScript の自動インストールで外へ出ることがある。
 */
const PROXY_NAMES = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)$/;

/** npm の設定は渡すが、認証に関わる名前は渡さない（npm_config__authToken など） */
const NPM_CONFIG = /^npm_config_/i;
const SECRETISH = /(auth|token|password|passwd|secret|credential|_key$|^npm_config_key$|cert$|otp)/i;

/** 資格情報つきの URL か */
const HAS_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i;

/**
 * Next が IDE 自身のために設定する変数。許可リストには無いので渡らないが、
 * `npm_config_*` などの許可の網と重ならないよう、明示して落とす（Phase 7A 第2.5節）。
 */
const IDE_OWN_ENV = /^(NODE_ENV|PORT|NEXT_RUNTIME|NEXT_DEPLOYMENT_ID|TURBOPACK|__NEXT_.*|NEXT_PRIVATE_.*|npm_package_.*|npm_lifecycle_.*)$/;

export interface ChildEnvReport {
  env: NodeJS.ProcessEnv;
  /** 渡した変数の名前（値は持たない） */
  passed: string[];
  /** 渡さなかった変数の数。名前は返さない（名前自体が手がかりになりうる） */
  withheld: number;
  /** 利用者の明示（VCIDE_CHILD_ENV_PASS）で渡した変数の名前 */
  explicit: string[];
}

function explicitNames(base: NodeJS.ProcessEnv): Set<string> {
  const raw = base.VCIDE_CHILD_ENV_PASS ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)));
}

/** 子に渡してよい変数か（値も見る。プロキシの資格情報のため） */
function allowed(k: string, v: string | undefined, explicit: Set<string>): boolean {
  if (v === undefined) return false;
  if (k.startsWith('VCIDE_')) return false;           // IDE 自身の設定
  if (IDE_OWN_ENV.test(k)) return false;
  if (explicit.has(k)) return true;
  if (ALLOW_EXACT.has(k)) return true;
  if (ALLOW_PREFIX.some((re) => re.test(k))) return true;
  if (PROXY_NAMES.test(k)) return !HAS_USERINFO.test(v);
  if (NPM_CONFIG.test(k)) return !SECRETISH.test(k.replace(NPM_CONFIG, '')) && !HAS_USERINFO.test(v);
  return false;
}

export function childEnvReport(base: NodeJS.ProcessEnv): ChildEnvReport {
  const explicit = explicitNames(base);
  // NODE_ENV を意図して落とすため、Next の型（NODE_ENV 必須）ではなく素の辞書で組む
  const env: Record<string, string | undefined> = {};
  const passed: string[] = [];
  let withheld = 0;
  for (const [k, v] of Object.entries(base)) {
    if (allowed(k, v, explicit)) { env[k] = v; passed.push(k); } else if (v !== undefined) withheld += 1;
  }
  env.NEXT_TELEMETRY_DISABLED = '1';
  return {
    env: env as NodeJS.ProcessEnv,
    passed: passed.sort(),
    withheld,
    explicit: [...explicit].filter((k) => k in env).sort(),
  };
}

/** 子（対象の next dev）に渡す環境。許可した変数だけを持つ */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return childEnvReport(base).env;
}
