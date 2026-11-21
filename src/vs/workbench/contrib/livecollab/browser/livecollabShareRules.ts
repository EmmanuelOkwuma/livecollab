/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a shared folder never sends to the room, by name: files and folders
// that look like secrets. Matched case-insensitively on room-relative paths
// ('/'-separated). Used by the attach walk and the runtime create path
// (livecollabFolderContribution.ts). Links are handled there, by file type,
// not here: a link is never followed, whatever its name.

// Folders whose whole content is credentials or key material, wherever they
// sit in the shared folder.
const SECRET_DIRS = new Set(['.ssh', '.gnupg']);

// Folders that hold secrets only at the top of the shared folder (Docker and
// Kubernetes keep secret files in ./secrets). Deeper down, a folder of that
// name is usually code (src/secrets/ in a secrets manager) and is shared.
const TOP_LEVEL_SECRET_DIRS = new Set(['secrets', '.secrets']);

// .env files made to be committed and shared: templates with no real values.
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults', '.env.dist']);

// Keys, keystores and variable files with secrets, by extension.
const SECRET_EXTS = new Set([
	'.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.p8', '.ppk', '.keytab', '.kdbx', '.tfvars'
]);

// Credential files known by their exact name.
const SECRET_NAMES = new Set([
	'.npmrc', '.netrc', '_netrc', '.git-credentials', '.pgpass', '.pypirc', '.dockercfg',
	'.htpasswd', '.s3cfg', '.boto', '.yarnrc.yml', '.terraformrc', 'terraform.rc'
]);

// Credential files known by their folder and name.
const SECRET_PATHS = ['.docker/config.json', '.kube/config'];

// Name prefixes of credential files, except source files (e.g.
// credentialsService.ts, secretsManager.py), so code is never silently hidden.
const SECRET_PREFIXES = ['credentials', 'secrets', 'service-account', 'serviceaccount'];

// OpenSSH private (and public) keys under their default names and their
// copies: id_rsa, id_ed25519, id_ecdsa_sk.pub, id_rsa_old …
const SSH_KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519|xmss)(?![a-z0-9])/;

// "token" in the name (token.json, .vault-token, github_token), except the
// plural and the tokenizer family: design-token files (tokens.json,
// tokens.css) and tokenizer code are ordinary project content.
const TOKEN_NAME = /token(?!s|iz|is)/;

const SOURCE_EXTS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rb', '.rs',
	'.cs', '.c', '.h', '.cpp', '.hpp', '.swift', '.php', '.dart', '.vue', '.svelte'
]);

/**
 * Why a folder must never be shared with a room because of its name and
 * place, or undefined if it may be shared. `path` is the room-relative path.
 */
export function secretFolderRule(path: string): string | undefined {
	const segments = path.split('/');
	const name = segments[segments.length - 1];
	const lower = name.toLowerCase();
	if (SECRET_DIRS.has(lower) || (segments.length === 1 && TOP_LEVEL_SECRET_DIRS.has(lower))) {
		return `secret folder '${name}'`;
	}
	return undefined;
}

/**
 * Why a file must never be shared with a room because of its name or place,
 * or undefined if it may be shared. `path` is the room-relative path.
 */
export function secretFileRule(path: string): string | undefined {
	const segments = path.split('/');
	const name = segments[segments.length - 1];
	const lower = name.toLowerCase();
	const reason = `secret file '${name}'`;
	if (lower === '.env' || (lower.startsWith('.env.') && !ENV_TEMPLATES.has(lower))) { return reason; }
	if (SECRET_NAMES.has(lower)) { return reason; }
	const lowerPath = segments.slice(-2).join('/').toLowerCase();
	if (SECRET_PATHS.includes(lowerPath)) { return reason; }
	if (lower.endsWith('.tfvars.json')) { return reason; }
	const dot = lower.lastIndexOf('.');
	const ext = dot > 0 ? lower.slice(dot) : '';
	if (SECRET_EXTS.has(ext)) { return reason; }
	if (SOURCE_EXTS.has(ext)) { return undefined; } // code is never hidden by its name (id_rsa_parser.ts)
	if (SSH_KEY_NAME.test(lower)) { return reason; }
	if (SECRET_PREFIXES.some(p => lower.startsWith(p))) { return reason; }
	if (TOKEN_NAME.test(lower)) { return reason; }
	return undefined;
}

/**
 * Why a room-relative path from the room must never be applied to the
 * owner's disk, or undefined if it is a plain path inside the folder. Joining
 * a '..' segment would leave the folder (row 28).
 */
export function roomPathProblem(path: string): string | undefined {
	if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
		return 'not a plain room path';
	}
	if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
		return 'empty, \'.\' or \'..\' segment';
	}
	return undefined;
}
