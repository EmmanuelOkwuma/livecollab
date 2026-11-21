/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// LiveCollab: redaction applied to everything Sentry sends (breadcrumbs,
// error events, transactions). Sentry's console integration turns any
// console output into breadcrumbs, so without this a single log line that
// prints a token uploads it to a third party. Redacts values, never drops
// the breadcrumb: breadcrumbs stay useful for debugging crashes.
// The dashboard pages (livecollab-bootstrap.html / -dev.html) import this
// module directly — the only first-party module imported from HTML in the
// tree. That depends on: both exports carrying @skipMangle (the mangler
// cannot see an HTML importer and would otherwise rename them), and this
// file being listed for shipping in build/gulpfile.vscode.ts and
// build/next/index.ts (bundled modules are not separate files otherwise).

const redactions: ReadonlyArray<[RegExp, string]> = [
	// JWTs (session tokens, the Clerk handshake): header.payload[.signature]
	[/eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '[redacted-jwt]'],
	// Clerk / Stripe-style keys
	[/\b((?:sk|pk|rk)_(?:live|test)_)[A-Za-z0-9]+/g, '$1[redacted]'],
	// Clerk development-instance dev-browser tokens
	[/\bdvb_[A-Za-z0-9]+/g, 'dvb_[redacted]'],
	// Any __clerk_* query parameter (e.g. __clerk_db_jwt, __clerk_handshake)
	[/(__clerk_[A-Za-z0-9_]+=)[^&\s"'#]+/g, '$1[redacted]'],
	// Deep-link secrets: livecollab://reset-password?token=…, ?session=…
	[/([?&](?:token|session)=)[^&\s"'#]+/gi, '$1[redacted]'],
	// The person's account name in a home folder path (SENTRY_AUDIT.md: testers' macOS
	// usernames were in events): /Users/<name>, /home/<name>, C:\Users\<name>.
	[/(\/(?:Users|home)\/)(?!\[user\])[^/\\\s"'`]+/g, '$1[user]'],
	[/([A-Za-z]:\\{1,2}Users\\{1,2})(?!\[user\])[^\\/\s"'`]+/g, '$1[user]'],
];

const maxDepth = 10;

/**
 * Returns the string with every token-shaped substring redacted.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function redactSecretsInString(value: string): string {
	let result = value;
	for (const [pattern, replacement] of redactions) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

/**
 * Returns a copy of the value with every string inside it (at any depth)
 * passed through {@link redactSecretsInString}. Errors become plain
 * `{ name, message, stack }` objects so their text is redacted too.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function redactSecrets<T>(value: T): T {
	return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
	if (typeof value === 'string') {
		return redactSecretsInString(value);
	}
	if (value === null || typeof value !== 'object' || depth >= maxDepth) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(item => redactValue(item, depth + 1));
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactSecretsInString(value.message),
			stack: value.stack === undefined ? undefined : redactSecretsInString(value.stack),
		};
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = redactValue(item, depth + 1);
	}
	return result;
}

/**
 * What Sentry may keep of a breadcrumb. Console breadcrumbs are dropped: every log line becomes
 * one, and log lines carry room ids and the paths of files in rooms (SENTRY_AUDIT.md). Any other
 * breadcrumb is kept, redacted.
 *
 * @skipMangle imported by name from the dashboard HTML, which the mangler
 * cannot see.
 */
export function sentryBreadcrumb<T extends { category?: string }>(breadcrumb: T): T | null {
	return breadcrumb.category === 'console' ? null : redactSecrets(breadcrumb);
}
