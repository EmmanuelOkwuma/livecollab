/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { roomPathProblem, secretFileRule, secretFolderRule } from '../../browser/livecollabShareRules.js';

suite('LiveCollab share rules (what a shared folder never sends to the room)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('files: withheld, and look-alikes that must stay shared', () => {
		const withheld = [
			// .env files with values
			'.env', 'app/.env.local', '.env.production', '.ENV.LOCAL', '.env.example.local',
			// SSH keys under their default names, copies and public halves
			'id_rsa', 'id_rsa_old', 'id_rsa.bak', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa_sk.pub', 'keys/id_dsa', 'ID_XMSS',
			// keys, keystores, variable files by extension
			'server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'app.keystore', 'release.jks', 'AuthKey.p8', 'putty.ppk',
			'krb.keytab', 'vault.kdbx', 'prod.tfvars', 'infra/prod.tfvars.json',
			// credential files by name
			'.npmrc', '.netrc', '_netrc', '.git-credentials', '.pgpass', '.pypirc', '.dockercfg', '.htpasswd', '.s3cfg',
			'.boto', '.yarnrc.yml', '.terraformrc', 'terraform.rc',
			// by folder and name
			'.docker/config.json', 'home/.kube/config',
			// prefixes, outside source files
			'credentials.json', 'credentials', 'secrets.yaml', 'service-account.json', 'serviceAccount-prod.json',
			// "token" in the name
			'token.json', '.vault-token', 'github_token', 'ACCESS_TOKEN.txt', 'refresh-token',
		];
		const shared = [
			'README.md', 'src/index.ts', 'package.json', 'config.json',
			// .env templates are made to be committed
			'.env.example', '.env.sample', '.env.template', '.env.defaults', '.env.dist', 'app/.env.example', '.envrc.example',
			// source files whose names start like a credential file
			'credentialsService.ts', 'secretsManager.py', 'src/credentials.go', 'serviceAccount.java',
			// tokens (plural) and the tokenizer family
			'tokens.json', 'design/tokens.css', 'tokenizer.ts', 'tokenize.go', 'tokenise.py', 'src/lexer/tokenStream.ts',
			// near-misses for the other rules
			'docker/config.json', 'kube/config', 'id_map.json', 'identity.md', 'id_rsa_parser.ts', 'keyboard.ts', 'monkey.txt',
			'npmrc.md', 'pemfile.txt',
		];
		assert.deepStrictEqual(
			[...withheld, ...shared].filter(p => secretFileRule(p)),
			withheld
		);
	});

	test('folders: .ssh and .gnupg anywhere, secrets only at the top', () => {
		const paths = ['.ssh', 'home/.ssh', '.GnuPG', 'secrets', '.secrets', 'Secrets', 'src/secrets', 'app/config/secrets', 'src', '.docker', '.kube'];
		assert.deepStrictEqual(
			paths.filter(p => secretFolderRule(p)),
			['.ssh', 'home/.ssh', '.GnuPG', 'secrets', '.secrets', 'Secrets']
		);
	});

	test('room paths from the room: only plain paths inside the folder', () => {
		const paths = ['a.txt', 'src/app/page.tsx', '.env.example', '..a', 'a..b/c',
			'../x', 'a/../../x', '..', './a', 'a/./b', '/etc/passwd', 'a//b', 'a/', '', 'a\\..\\b', 'a\0b'];
		assert.deepStrictEqual(
			paths.filter(p => !roomPathProblem(p)),
			['a.txt', 'src/app/page.tsx', '.env.example', '..a', 'a..b/c']
		);
	});
});
