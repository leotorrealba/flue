import { describe, expect, it, vi } from 'vitest';
import { createTools } from '../src/agent.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

describe('createTools()', () => {
	it('uses rg and caches the probe when grep runs repeatedly', async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: 'ripgrep 14.1.0', stderr: '', exitCode: 0 })
			.mockResolvedValue({ stdout: 'src/a.ts:1:match', stderr: '', exitCode: 0 });
		const env = createNoopSessionEnv({ exec });
		const grep = createTools(env).find((tool) => tool.name === 'grep');

		await grep?.execute('first', { pattern: 'match', include: '*.ts' });
		await grep?.execute('second', { pattern: 'match', include: '*.ts' });

		expect(exec).toHaveBeenCalledTimes(3);
		expect(exec).toHaveBeenNthCalledWith(1, 'rg --version');
		expect(exec.mock.calls[1]?.[0]).toContain('rg --line-number --with-filename --color never');
		expect(exec.mock.calls[1]?.[0]).toContain("--glob '*.ts' -- 'match' '.'");
		expect(exec.mock.calls[2]?.[0]).toContain('rg --line-number --with-filename --color never');
	});

	it('uses grep with extended regex when the rg probe is unavailable', async () => {
		const exec = vi
			.fn()
			.mockRejectedValueOnce(new Error('not found'))
			.mockResolvedValueOnce({ stdout: 'src/a.ts:1:match', stderr: '', exitCode: 0 });
		const grep = createTools(createNoopSessionEnv({ exec })).find((tool) => tool.name === 'grep');

		await grep?.execute('call', { pattern: 'match', path: 'src', include: '*.ts' });

		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[1]?.[0]).toContain("grep -rnH -E --include='*.ts' -- 'match' 'src'");
	});

	it('uses the backend fixed-string flag when literal mode is enabled', async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: 'ripgrep 14.1.0', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'src/a.ts:1:a.b', stderr: '', exitCode: 0 });
		const grep = createTools(createNoopSessionEnv({ exec })).find((tool) => tool.name === 'grep');

		await grep?.execute('call', { pattern: 'a.b', literal: true });

		expect(exec.mock.calls[1]?.[0]).toContain("--fixed-strings -- 'a.b' '.'");
	});
});
