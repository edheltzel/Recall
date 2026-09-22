import { scoreCandidate } from '../providers/jev.js';

export async function runJev(input: {
  text?: string;
  kind?: string;
  project?: string;
}): Promise<void> {
  const text = input.text?.trim()
    ? input.text.trim()
    : process.stdin.isTTY
      ? ''
      : (await Bun.stdin.text()).trim();
  if (!text) {
    console.error('Pass candidate memory text as an argument or on stdin.');
    process.exitCode = 1;
    return;
  }

  try {
    const decision = await scoreCandidate({
      text,
      kind: input.kind?.trim() || undefined,
      project: input.project?.trim() || undefined,
    });
    console.log(JSON.stringify(decision));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
