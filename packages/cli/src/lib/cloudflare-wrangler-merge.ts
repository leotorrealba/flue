/**
 * Merge Flue's Cloudflare additions into the user's wrangler config.
 *
 * Philosophy: the user's wrangler config is the source of truth. Flue contributes
 * the pieces it owns (the Worker entrypoint and its generated Durable Object
 * bindings) and leaves everything else untouched. The merged result is written
 * as the official Vite plugin's input configuration so its output Worker sees
 * both.
 *
 * We delegate configuration parsing and validation to Wrangler, while retaining
 * environment blocks in the generated input configuration for the Vite plugin.
 * Flue owns Durable Object binding de-duplication and Flue-specific validation
 * (compat date floor, required compat flags), but migration history remains
 * entirely user-authored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Unstable_Config, Unstable_RawConfig } from 'wrangler';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum compatibility_date Flue supports. */
const MIN_COMPATIBILITY_DATE = '2026-04-01';

/** compatibility_flag Flue requires for pi-ai's process.env-based API key lookup. */
const REQUIRED_COMPAT_FLAG = 'nodejs_compat';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A Flue-owned generated DO binding. */
interface DoBinding {
	class_name: string;
	name: string;
}

/**
 * Everything Flue contributes to the wrangler config.
 *
 * Flue contributes generated Durable Object bindings. Everything else — user
 * Durable Object bindings (e.g. Sandbox), container entries, and the complete
 * Durable Object migration history — belongs to the user's own wrangler.jsonc
 * and is passed through untouched during merge.
 */
export interface FlueAdditions {
	/** Fallback name if the user didn't set one in their wrangler config. */
	defaultName: string;
	/** Always written; Flue owns the generated Worker source entry. */
	main: string;
	/** Flue's generated DO bindings. Merged into durable_objects.bindings by `name`. */
	doBindings: DoBinding[];
}

// ─── Reading user config ────────────────────────────────────────────────────

interface UserConfigRead {
	config: Record<string, unknown>;
	effectiveConfig: Record<string, unknown>;
	/** Absolute path of the user config file that was read, or null if none existed. */
	path: string | null;
}

export async function readUserWranglerConfig(root: string): Promise<UserConfigRead> {
	const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
	let foundPath: string | null = null;
	for (const name of candidates) {
		const candidate = path.join(root, name);
		if (fs.existsSync(candidate)) {
			foundPath = candidate;
			break;
		}
	}

	if (!foundPath) {
		return { config: {}, effectiveConfig: {}, path: null };
	}

	let wrangler: typeof import('wrangler');
	try {
		wrangler = (await import('wrangler')) as typeof import('wrangler');
	} catch (err) {
		throw new Error(
			`[flue] Reading the Cloudflare wrangler config requires the "wrangler" package as a peer dependency.\n` +
				`Install it in your project:\n\n` +
				`  npm install --save-dev wrangler\n\n` +
				`Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let raw: Unstable_RawConfig;
	let effective: Unstable_Config;
	try {
		raw = wrangler.experimental_readRawConfig({ config: foundPath }).rawConfig;
		effective = wrangler.unstable_readConfig({ config: foundPath }, { hideWarnings: true });
	} catch (err) {
		throw new Error(
			`[flue] Failed to read ${foundPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		config: raw as unknown as Record<string, unknown>,
		effectiveConfig: effective as unknown as Record<string, unknown>,
		path: foundPath,
	};
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate that the user's wrangler config meets Flue's minimum runtime
 * requirements. Throws a clear error describing the fix if it doesn't.
 *
 * We're intentionally strict here rather than silently massaging bad configs —
 * the failure modes when these are wrong (missing nodejs_compat, old
 * compat_date) produce confusing runtime errors, and surfacing the problem at
 * build time is much friendlier.
 *
 * Together with `mergeFlueAdditions`, this enforces two invariants on every
 * Flue worker:
 *   1. `nodejs_compat` is in `compatibility_flags` (added if missing).
 *   2. `compatibility_date >= MIN_COMPATIBILITY_DATE` (defaulted if missing).
 *
 * Those invariants are what let `dev.ts` hardcode `nodejsCompatMode: 'v2'`
 * without re-deriving it from the config on every reload.
 */
export function validateUserWranglerConfig(config: Record<string, unknown>): void {
	// compatibility_flags must include nodejs_compat if user set the field.
	// (If unset, Flue adds it during merge — handled in mergeFlueAdditions.)
	if (Array.isArray(config.compatibility_flags)) {
		const flags = config.compatibility_flags as unknown[];
		if (!flags.includes(REQUIRED_COMPAT_FLAG)) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_flags" is missing "${REQUIRED_COMPAT_FLAG}". ` +
					`Flue relies on it at runtime (e.g. for API key resolution via process.env). ` +
					`Add "${REQUIRED_COMPAT_FLAG}" to the list.`,
			);
		}
	}

	// compatibility_date must be on or after the minimum, if set.
	if (typeof config.compatibility_date === 'string') {
		const userDate = config.compatibility_date;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(userDate)) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_date" ("${userDate}") is not in YYYY-MM-DD format.`,
			);
		}
		if (userDate < MIN_COMPATIBILITY_DATE) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_date" is "${userDate}". ` +
					`Flue requires at least "${MIN_COMPATIBILITY_DATE}" for SQLite-backed Durable Object support, nodejs_compat v2, and AsyncLocalStorage. ` +
					`Bump the date (set it to today unless you have a specific reason).`,
			);
		}
	}
}

// ─── Merging ────────────────────────────────────────────────────────────────

/**
 * Produce the merged wrangler config: start from the user's, layer Flue's
 * contributions on top. Pure function — caller handles reading and writing.
 */
export function mergeFlueAdditions(
	userConfig: Record<string, unknown>,
	additions: FlueAdditions,
): Record<string, unknown> {
	// Shallow clone so we don't mutate the user's parsed config in place.
	const merged: Record<string, unknown> = { ...userConfig };

	// main: Flue always wins. Flue owns the generated Worker source entry that
	// the official Vite plugin builds for deployment. A conflicting user main
	// would bypass that runtime bootstrap.
	merged.main = additions.main;

	// name: user wins if set; fall back to the default we derive from root.
	if (typeof merged.name !== 'string' || merged.name.length === 0) {
		merged.name = additions.defaultName;
	}

	// compatibility_date: user wins if set; fall back to Flue's known-good
	// minimum. (validateUserWranglerConfig already ensured any user-set value
	// meets Flue's minimum.)
	//
	// We deliberately do NOT default to "today's date". A user running an
	// older Flue install gets a workerd version that's pinned via wrangler;
	// "today" can be ahead of that workerd's supported compat range and
	// produce a confusing "compatibility_date is in the future" error. The
	// floor is conservative but correct for any Flue release.
	if (typeof merged.compatibility_date !== 'string') {
		merged.compatibility_date = MIN_COMPATIBILITY_DATE;
	}

	// compatibility_flags: union with nodejs_compat. (validateUserWranglerConfig
	// already rejected arrays that were set but missing nodejs_compat.)
	const existingFlags = Array.isArray(merged.compatibility_flags)
		? (merged.compatibility_flags as unknown[]).filter((f): f is string => typeof f === 'string')
		: [];
	if (!existingFlags.includes(REQUIRED_COMPAT_FLAG)) {
		existingFlags.push(REQUIRED_COMPAT_FLAG);
	}
	merged.compatibility_flags = existingFlags;

	const mergeDurableObjectBindings = (config: Record<string, unknown>): void => {
		const existingDo =
			typeof config.durable_objects === 'object' && config.durable_objects !== null
				? (config.durable_objects as Record<string, unknown>)
				: {};
		const existingBindings = Array.isArray(existingDo.bindings)
			? (existingDo.bindings as unknown[])
			: [];
		const existingBindingNames = new Set(
			existingBindings
				.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
				.map((b) => b.name)
				.filter((n): n is string => typeof n === 'string'),
		);
		for (const binding of additions.doBindings) {
			if (binding.name !== 'FLUE_REGISTRY') continue;
			if (!existingBindingNames.has(binding.name)) continue;
			const existing = existingBindings.find(
				(b): b is Record<string, unknown> => {
					if (typeof b !== 'object' || b === null) return false;
					return (b as Record<string, unknown>).name === binding.name;
				},
			);
			if (existing?.class_name !== binding.class_name) {
				throw new Error(
					`[flue] wrangler.jsonc durable object binding "${binding.name}" is reserved by Flue. ` +
						`Expected class_name "${binding.class_name}", received "${String(existing?.class_name)}".`,
				);
			}
		}
		const flueBindingsToAdd = additions.doBindings.filter((b) => !existingBindingNames.has(b.name));
		config.durable_objects = {
			...existingDo,
			bindings: [...existingBindings, ...flueBindingsToAdd],
		};
	};

	mergeDurableObjectBindings(merged);
	if (typeof merged.env === 'object' && merged.env !== null) {
		const environments = { ...(merged.env as Record<string, unknown>) };
		for (const [name, value] of Object.entries(environments)) {
			if (typeof value !== 'object' || value === null) continue;
			const environment = { ...(value as Record<string, unknown>) };
			environment.main = additions.main;
			mergeDurableObjectBindings(environment);
			environments[name] = environment;
		}
		merged.env = environments;
	}

	// containers: user owns the `containers` array entirely. Flue contributes
	// nothing here — any entries the user declared pass through untouched via
	// the shallow `{ ...userConfig }` clone above. Nothing to merge.

	return merged;
}

// ─── Sandbox binding detection ──────────────────────────────────────────────

/**
 * Return the list of `class_name`s declared in the user's wrangler
 * `durable_objects.bindings` that end with the literal suffix `Sandbox`
 * (case-sensitive).
 *
 * This is Flue's convention for wiring `@cloudflare/sandbox`: any DO binding
 * whose class name ends with `Sandbox` triggers an automatic re-export in the
 * generated Worker entry:
 *
 *   export { Sandbox as <class_name> } from '@cloudflare/sandbox';
 *
 * The alias lets users pick arbitrary class names (e.g. `PyBoxSandbox`,
 * `SupportSandbox`) while still pointing at the single class shipped by the
 * `@cloudflare/sandbox` package. Each distinct `class_name` can be paired with
 * a different container image in the user's `containers[]` config.
 *
 * The match is intentionally a suffix (not substring) so that user-defined
 * classes whose names merely contain "Sandbox" mid-word — e.g. `MySandboxV2`,
 * `MySandboxedAgent`, `LegacySandboxedThing` — are not silently overridden
 * by the `@cloudflare/sandbox` re-export. Note that classes whose names
 * still end in `Sandbox` (e.g. `MockSandbox`, `NotASandbox`) will match;
 * to opt out, rename the class to not end in `Sandbox`.
 *
 * Returns unique, sorted class names. Non-object bindings or bindings without
 * a string `class_name` are ignored.
 */
export function detectSandboxBindings(userConfig: Record<string, unknown>): string[] {
	const doObj = userConfig.durable_objects;
	if (typeof doObj !== 'object' || doObj === null) return [];
	const bindings = (doObj as Record<string, unknown>).bindings;
	if (!Array.isArray(bindings)) return [];

	const found = new Set<string>();
	for (const entry of bindings) {
		if (typeof entry !== 'object' || entry === null) continue;
		const className = (entry as Record<string, unknown>).class_name;
		if (typeof className !== 'string') continue;
		if (className.endsWith('Sandbox')) found.add(className);
	}
	return Array.from(found).sort();
}

// ─── @cloudflare/sandbox install check ──────────────────────────────────────

/**
 * When the user has declared one or more `Sandbox`-named DO bindings, verify
 * that `@cloudflare/sandbox` is declared in the nearest package.json. Surfaces
 * a friendly, actionable error at build time rather than letting the bundler
 * emit a confusing module-resolution failure.
 *
 * The check is lenient: if no package.json can be located or parsed, we skip
 * silently and let the bundler's own error path take over. This avoids false
 * positives in unusual project layouts.
 */
export function assertSandboxPackageInstalled(
	sandboxClassNames: string[],
	root: string,
): void {
	if (sandboxClassNames.length === 0) return;

	let current = root;
	while (current !== path.dirname(current)) {
		const pkgPath = path.join(current, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
				const allDeps = {
					...(pkg.dependencies ?? {}),
					...(pkg.devDependencies ?? {}),
					...(pkg.peerDependencies ?? {}),
					...(pkg.optionalDependencies ?? {}),
				};
				if ('@cloudflare/sandbox' in allDeps) return;
				// Found a package.json but no dep — keep walking in case this
				// is a nested package and the dep is declared higher up (e.g.
				// pnpm workspace root).
			} catch {
				return; // unparseable package.json — give up, let the bundler report it
			}
		}
		current = path.dirname(current);
	}

	throw new Error(
		`[flue] Your wrangler config declares DO binding(s) whose class_name ends with "Sandbox" ` +
			`(${sandboxClassNames.join(', ')}), but @cloudflare/sandbox is not in your package.json. ` +
			`Install it: \`npm install @cloudflare/sandbox\`.`,
	);
}
