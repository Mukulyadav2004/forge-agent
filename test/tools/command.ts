import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Frame } from 'playwright-core';
import { z } from 'zod';

const CommandSchema = z.object({
  command: z.string(), cwd: z.string(), exit_code: z.number().nullable(), signal: z.string().nullable(), timed_out: z.boolean(), cancelled: z.boolean(),
  duration_ms: z.number(), output: z.string(), output_truncated: z.boolean(), total_output_characters: z.number(), context_budget: z.object({ used: z.number(), limit: z.number() }),
});

/** run_command through the real MCP server: exit codes, cwd containment, timeout and bounded output. */
export async function checkCommand(options: { client: Client; frame: Frame }): Promise<void> {
  const run = async (args: Record<string, unknown>) => {
    const result = await options.client.callTool({ name: 'run_command', arguments: args });
    return { result, data: result.isError ? undefined : CommandSchema.parse(result.structuredContent) };
  };
  const failing = (await run({ command: 'echo checked; echo warn >&2; exit 3', reason: 'Check the exit code' })).data;
  assert.ok(failing);
  assert.deepEqual([failing.exit_code, failing.cwd, failing.timed_out], [3, '.', false]);
  assert.match(failing.output, /checked[\s\S]*warn/u, 'stdout and stderr are both returned.');
  assert.equal((await run({ command: 'pwd', cwd: '..' })).result.isError, true, 'cwd must stay inside the workspace.');
  assert.equal((await run({ command: 'pwd', cwd: 'missing-folder' })).result.isError, true);
  const started = Date.now();
  const slow = (await run({ command: 'sleep 30', timeout_seconds: 1 })).data;
  assert.ok(slow?.timed_out && Date.now() - started < 10_000, 'The timeout stops the command and its process group.');
  const long = (await run({ command: "head -c 60000 /dev/zero | tr '\\\\0' 'x'; echo; echo LAST-LINE" })).data;
  assert.ok(long?.output_truncated, 'Long output is shortened.');
  assert.ok(long.output.length < 16_200 && long.total_output_characters > 60_000);
  assert.match(long.output, /characters omitted[\s\S]*LAST-LINE/u, 'The end of the output, where errors usually are, is kept.');
  assert.ok(long.context_budget.used > 0);
  // failing, sleep and long output are three commands that ran (the refused cwd calls do not count); five more reach the limit of eight.
  for (let index = 4; index <= 8; index += 1) assert.equal((await run({ command: `echo command ${index}` })).data?.exit_code, 0, `Command ${index} of 8 runs.`);
  const ninth = await run({ command: 'echo one too many' });
  assert.equal(ninth.result.isError, true, 'A request runs at most eight commands.');
  assert.match(JSON.stringify(ninth.result.content), /already ran 8 commands, the limit per request/u);
  const row = options.frame.locator('#messages .activity-command').filter({ hasText: 'echo checked' });
  await row.waitFor();
  assert.match(await row.innerText(), /^Ran\s+echo checked; echo warn >&2; exit 3\s+exit 3 after [\d.]+ s \(\+\d+ chars\)[\s\S]*Check the exit code/u);
  assert.ok((await options.frame.locator('#messages .activity-command').filter({ hasText: 'sleep 30' }).innerText()).includes('timed out'));
  assert.ok(await options.frame.locator('#messages .activity-card.activity-command').count() >= 3, 'Each command that ran is its own row in the conversation.');
  await options.frame.locator('#messages .activity-refused').filter({ hasText: 'run_command: cwd must stay inside the workspace.' }).waitFor();
}
