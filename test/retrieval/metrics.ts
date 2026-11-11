function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  if (typeof value !== 'string') return undefined;
  try { const result: unknown = JSON.parse(value); return record(result) ? result : undefined; }
  catch { return undefined; }
}

export function measureTrace(options: { events: unknown[]; targets: string[] }) {
  const events = options.events.filter(record);
  const calls = new Map<string, { name: string; args: Record<string, unknown> | undefined }>();
  for (const event of events) {
    if (event.type !== 'model.message' || !Array.isArray(event.tool_calls)) continue;
    for (const call of event.tool_calls) {
      if (!record(call) || typeof call.id !== 'string' || !record(call.function)) continue;
      const name = record(call.tool_info) ? call.tool_info.name : call.function.name;
      if (typeof name === 'string') calls.set(call.id, { name, args: decode(call.function.arguments) });
    }
  }
  const searches: { query: unknown; glob: unknown; result_characters: number; success: boolean; returned_matches: number; by_file: Record<string, number>; truncated: unknown }[] = [];
  const readRanges: { path: string; start_line: unknown; end_line: unknown }[] = [];
  const characters = { search: 0, read: 0, all_tools: 0 };
  for (const event of events) {
    if (event.type !== 'tool.response' || typeof event.tool_call_id !== 'string') continue;
    const call = calls.get(event.tool_call_id);
    const length = typeof event.content === 'string' ? event.content.length : 0;
    characters.all_tools += length;
    const result = decode(event.content);
    if (call?.name === 'search_code') {
      characters.search += length;
      const byFile: Record<string, number> = {};
      if (Array.isArray(result?.matches)) {
        for (const match of result.matches) if (record(match) && typeof match.path === 'string') byFile[match.path] = (byFile[match.path] ?? 0) + 1;
      }
      if (Array.isArray(result?.files)) {
        for (const file of result.files) if (record(file) && typeof file.path === 'string' && Array.isArray(file.matches)) byFile[file.path] = file.matches.length;
      }
      searches.push({ query: call.args?.query, glob: call.args?.glob, result_characters: length, success: !!result && result.isError !== true && (Array.isArray(result.matches) || Array.isArray(result.files)), returned_matches: Object.values(byFile).reduce((sum, count) => sum + count, 0), by_file: byFile, truncated: result?.truncated });
    }
    if (call?.name === 'read_file') {
      characters.read += length;
      if (result && result.isError !== true && typeof result.path === 'string' && result.path === call.args?.path && typeof result.text === 'string' && typeof result.base_revision === 'string') {
        readRanges.push({ path: result.path, start_line: result.start_line, end_line: result.end_line });
      }
    }
  }
  const filesRead = [...new Set(readRanges.map(read => read.path))];
  return {
    search_calls: [...calls.values()].filter(call => call.name === 'search_code').length,
    search_results: searches,
    read_calls: [...calls.values()].filter(call => call.name === 'read_file').length,
    files_read: filesRead, read_ranges: readRanges, characters_returned: characters,
    targets: Object.fromEntries(options.targets.map(path => [path, { appeared_in_results: searches.some(search => (search.by_file[path] ?? 0) > 0), read: filesRead.includes(path) }])),
  };
}
