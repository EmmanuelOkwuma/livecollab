/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether DevTools may open. LiveCollab builds come in two flavours, set at
 * build time in product.json (`livecollabBuildFlavor`): 'release' for
 * testers, with DevTools off, and 'dev' for our own machines. Running from
 * source (not built) always allows them. A built app with no flavour, or an
 * unknown one, is treated as release: it fails closed.
 *
 * There is deliberately no runtime switch. Note the limit (STATUS #4): in an
 * unsigned app product.json is a file anyone can edit, so this stops a
 * tester stumbling into DevTools, not someone determined to open them; code
 * signing is what makes an edited app fail to launch.
 */
export function isLiveCollabDevToolsAllowed(isBuilt: boolean, buildFlavor: string | undefined): boolean {
	return !isBuilt || buildFlavor === 'dev';
}

/** Where a LiveCollab app signs in and connects: the server, the website's sign-in page and the account page. */
export interface ILiveCollabEndpoints {
	readonly server: string;
	readonly signInPage: string;
	readonly accountPage: string;
}

/** The production endpoints, which every release build uses. */
export const LIVECOLLAB_PRODUCTION_ENDPOINTS: ILiveCollabEndpoints = {
	server: 'https://live-collab-production.up.railway.app',
	signInPage: 'https://livecollab.dev/desktop',
	// The production Clerk instance's Account Portal (Clerk step 1, CLERK_PRODUCTION_PLAN.md);
	// signed out, it asks you to sign in first.
	accountPage: 'https://accounts.livecollab.dev/user',
};

/**
 * The endpoints this app uses. A dev build, or a run from source, may point
 * them elsewhere (the local rig, a development page) through
 * `LIVECOLLAB_SERVER_URL`, `LIVECOLLAB_SIGNIN_URL` and `LIVECOLLAB_ACCOUNT_URL`,
 * the same gate as DevTools. A release build, and a built app with no or an
 * unknown flavour, ignores them entirely and uses production. A value that
 * isn't an http(s) address is ignored too.
 */
export function liveCollabEndpoints(isBuilt: boolean, buildFlavor: string | undefined, env: Readonly<Record<string, string | undefined>>): ILiveCollabEndpoints {
	if (!isLiveCollabDevToolsAllowed(isBuilt, buildFlavor)) {
		return LIVECOLLAB_PRODUCTION_ENDPOINTS;
	}
	const pick = (name: string, production: string) => {
		const value = env[name];
		return value && /^https?:\/\/[^\s]+$/.test(value) ? value.replace(/\/$/, '') : production;
	};
	return {
		server: pick('LIVECOLLAB_SERVER_URL', LIVECOLLAB_PRODUCTION_ENDPOINTS.server),
		signInPage: pick('LIVECOLLAB_SIGNIN_URL', LIVECOLLAB_PRODUCTION_ENDPOINTS.signInPage),
		accountPage: pick('LIVECOLLAB_ACCOUNT_URL', LIVECOLLAB_PRODUCTION_ENDPOINTS.accountPage),
	};
}

/**
 * Sentry's release for this app: LiveCollab's own version (product.json's
 * `livecollabVersion`), never VS Code's, which Sentry would use by default.
 */
export function liveCollabSentryRelease(livecollabVersion: string | undefined): string {
	return `LiveCollab@${livecollabVersion || 'unknown'}`;
}
