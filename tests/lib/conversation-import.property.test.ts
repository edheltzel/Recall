// Property-based tests for conversation import normalization (issue #44).
//
// Covers the pure parse/normalize layer shared by every source adapter:
// required fields preserved/derived, invalid and empty inputs rejected
// deterministically, and deterministic normalized output. Export (#43) and
// dedup (#45) property groups are deferred until those issues land.
//
// Generators always include message timestamps: messages without one get a
// `new Date()` fallback inside the parsers, which is legitimately
// time-dependent and would make determinism assertions meaningless.
// Generator sizes are bounded (≤3 conversations × ≤8 messages) so the suite
// stays practical under normal `bun test` runs.

import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import {
  conversationSourceAdapters,
  detectConversationFormat,
  parseChatGptConversations,
  parseClaudeAiConversations,
  parseSlackConversations,
  type ImportedConversationSource,
  type ParsedConversationSession,
} from '../../src/lib/conversation-import';

// Virtual paths only — the parse layer touches the filesystem solely when a
// Slack rootPath is provided, which these tests never do.
const CLAUDE_FILE = '/virtual/claude-export.json';
const CHATGPT_FILE = '/virtual/conversations.json';
const SLACK_FILE = '/virtual/team-channel/2026-05-31.json';

type Role = 'user' | 'assistant' | 'system';

interface GenMessage {
  role: Role;
  text: string;
  atSeconds: number;
}

interface GenConversation {
  id: string;
  title: string;
  messages: GenMessage[];
}

const textArb = fc.string({ maxLength: 60 });
const whitespaceTextArb = fc.constantFrom('', ' ', '  ', '\n', '\t', ' \n\t ');
// 2001-09-09 .. 2096-10-02 in epoch seconds — keeps ISO output 4-digit-year.
const secondsArb = fc.integer({ min: 1_000_000_000, max: 4_000_000_000 });
const roleArb = fc.constantFrom('user', 'assistant', 'system') as fc.Arbitrary<Role>;

const messageArb = (text: fc.Arbitrary<string>): fc.Arbitrary<GenMessage> =>
  fc.record({ role: roleArb, text, atSeconds: secondsArb });

const conversationArb = (text: fc.Arbitrary<string>): fc.Arbitrary<GenConversation> =>
  fc.record({
    id: fc.string({ maxLength: 40 }),
    title: fc.string({ maxLength: 40 }),
    messages: fc.array(messageArb(text), { maxLength: 8 }),
  });

const slackMessageArb = fc.record({ isBot: fc.boolean(), text: textArb, atSeconds: secondsArb });

// Empty string exercises the `project ||` default fallback in each parser.
const projectArb = fc.option(fc.constantFrom('proj-a', 'imported docs', ''), { nil: undefined });

function claudePayload(convos: GenConversation[]): unknown {
  return convos.map(c => ({
    uuid: c.id,
    name: c.title,
    chat_messages: c.messages.map(m => ({
      sender: m.role === 'user' ? 'human' : m.role,
      created_at: new Date(m.atSeconds * 1000).toISOString(),
      text: m.text,
    })),
  }));
}

function chatGptPayload(convos: GenConversation[]): unknown {
  return convos.map(c => {
    const mapping: Record<string, unknown> = {
      root: { id: 'root', parent: null, children: c.messages.length ? ['m1'] : [], message: null },
    };
    c.messages.forEach((m, i) => {
      mapping[`m${i + 1}`] = {
        id: `m${i + 1}`,
        parent: i === 0 ? 'root' : `m${i}`,
        children: i === c.messages.length - 1 ? [] : [`m${i + 2}`],
        message: {
          author: { role: m.role },
          create_time: m.atSeconds,
          content: { content_type: 'text', parts: [m.text] },
        },
      };
    });
    return { id: c.id, title: c.title, current_node: c.messages.length ? `m${c.messages.length}` : null, mapping };
  });
}

function slackPayload(messages: Array<{ isBot: boolean; text: string; atSeconds: number }>): unknown {
  return messages.map((m, i) =>
    m.isBot
      ? { ts: `${m.atSeconds}.${String(i).padStart(6, '0')}`, bot_id: 'B1', username: 'Recall Bot', subtype: 'bot_message', text: m.text }
      : { ts: `${m.atSeconds}.${String(i).padStart(6, '0')}`, user: 'U1', user_profile: { real_name: 'Ada Lovelace' }, text: m.text }
  );
}

const survives = (m: { text: string }): boolean => m.text.trim() !== '';

const SANITIZED_ID = /^[a-zA-Z0-9:._-]+$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The normalizeSession contract every adapter must satisfy (issue #44:
// "required fields are preserved/derived correctly").
function expectSessionInvariants(
  session: ParsedConversationSession,
  source: ImportedConversationSource,
  expectedProject: string
): void {
  expect(session.source).toBe(source);
  expect(session.sessionId).toMatch(SANITIZED_ID);
  expect(session.sessionId.startsWith(`${source}:`)).toBe(true);
  expect(session.sessionId.length).toBeLessThanOrEqual(180);
  expect(session.title.length).toBeGreaterThan(0);
  expect(session.title).toBe(session.title.trim());
  expect(session.project).toBe(expectedProject);
  expect(session.messages.length).toBeGreaterThan(0);
  expect(session.startedAt).toBe(session.messages[0].timestamp);
  expect(session.endedAt).toBe(session.messages[session.messages.length - 1].timestamp);

  for (const message of session.messages) {
    expect(message.session_id).toBe(session.sessionId);
    expect(message.project).toBe(expectedProject);
    expect(['user', 'assistant', 'system']).toContain(message.role);
    expect(message.content.trim().length).toBeGreaterThan(0);
    expect(message.timestamp).toMatch(ISO_TIMESTAMP);
  }
  for (let i = 1; i < session.messages.length; i++) {
    expect(session.messages[i - 1].timestamp.localeCompare(session.messages[i].timestamp)).toBeLessThanOrEqual(0);
  }
}

// claude-ai and chatgpt share multi-conversation parse semantics; only the
// payload shape, default project, and detection oracle differ. The chatgpt
// detector keys on the `mapping` object, present in every generated
// conversation regardless of message count, while claude-ai needs at least
// one message carrying a sender.
const multiConversationCases = [
  {
    source: 'claude-ai' as const,
    filePath: CLAUDE_FILE,
    parse: parseClaudeAiConversations,
    payload: claudePayload,
    detectable: (convos: GenConversation[]) => convos.some(c => c.messages.length > 0),
  },
  {
    source: 'chatgpt' as const,
    filePath: CHATGPT_FILE,
    parse: parseChatGptConversations,
    payload: chatGptPayload,
    detectable: (convos: GenConversation[]) => convos.length > 0,
  },
];

describe('conversation import normalization properties', () => {
  for (const adapterCase of multiConversationCases) {
    test(`${adapterCase.source}: sessions preserve and derive required fields; content survives exactly`, () => {
      fc.assert(
        fc.property(fc.array(conversationArb(textArb), { maxLength: 3 }), projectArb, (convos, project) => {
          const payload = adapterCase.payload(convos);
          const sessions = adapterCase.parse(payload, adapterCase.filePath, project);
          const surviving = convos.filter(c => c.messages.some(survives));
          const expectedProject = project || adapterCase.source;

          expect(sessions.length).toBe(surviving.length);
          sessions.forEach((session, i) => {
            expectSessionInvariants(session, adapterCase.source, expectedProject);
            // Multiset equality: every non-empty message body survives
            // normalization exactly once, none invented.
            const expectedContents = surviving[i].messages.filter(survives).map(m => m.text);
            expect([...session.messages.map(m => m.content)].sort()).toEqual([...expectedContents].sort());
          });

          expect(detectConversationFormat(payload)).toBe(adapterCase.detectable(convos) ? adapterCase.source : null);
        })
      );
    });
  }

  test('slack: sessions preserve and derive required fields; roles map by bot-ness', () => {
    fc.assert(
      fc.property(fc.array(slackMessageArb, { maxLength: 10 }), projectArb, (msgs, project) => {
        const payload = slackPayload(msgs);
        const sessions = parseSlackConversations(payload, SLACK_FILE, project);
        const surviving = msgs.filter(survives);
        const expectedProject = project || 'slack:team-channel';

        if (surviving.length === 0) {
          expect(sessions).toEqual([]);
        } else {
          expect(sessions.length).toBe(1);
          const session = sessions[0];
          expectSessionInvariants(session, 'slack', expectedProject);
          // Channel and date label are derived from the file path.
          expect(session.sessionId).toBe('slack:team-channel:2026-05-31');
          expect(session.messages.length).toBe(surviving.length);
          expect(session.messages.filter(m => m.role === 'assistant').length).toBe(surviving.filter(m => m.isBot).length);
        }

        expect(detectConversationFormat(payload)).toBe(msgs.length > 0 ? 'slack' : null);
      })
    );
  });

  test('conversations whose messages are all empty or whitespace yield no sessions in any adapter', () => {
    fc.assert(
      fc.property(fc.array(conversationArb(whitespaceTextArb), { minLength: 1, maxLength: 3 }), convos => {
        for (const adapterCase of multiConversationCases) {
          expect(adapterCase.parse(adapterCase.payload(convos), adapterCase.filePath)).toEqual([]);
        }
        const slackMsgs = convos[0].messages.map(m => ({ isBot: m.role === 'assistant', text: m.text, atSeconds: m.atSeconds }));
        expect(parseSlackConversations(slackPayload(slackMsgs), SLACK_FILE)).toEqual([]);
      })
    );
  });

  test('unrecognized input: when no adapter detects it, every adapter parses it to zero sessions, repeatably', () => {
    fc.assert(
      fc.property(fc.jsonValue(), data => {
        fc.pre(detectConversationFormat(data) === null);
        for (const adapter of conversationSourceAdapters) {
          const context = { filePath: SLACK_FILE };
          expect(adapter.parse(data, context)).toEqual([]);
          // Same rejection on a repeated call — no hidden state.
          expect(adapter.parse(data, context)).toEqual([]);
        }
        expect(detectConversationFormat(data)).toBeNull();
      })
    );
  });

  test('empty inputs are rejected: no detection, zero sessions', () => {
    for (const data of [[], {}, null, '', 0, false, undefined]) {
      expect(detectConversationFormat(data)).toBeNull();
      for (const adapter of conversationSourceAdapters) {
        expect(adapter.parse(data, { filePath: SLACK_FILE })).toEqual([]);
      }
    }
  });

  test('the same input always produces the same normalized output', () => {
    fc.assert(
      fc.property(
        fc.array(conversationArb(textArb), { maxLength: 2 }),
        fc.array(slackMessageArb, { maxLength: 6 }),
        (convos, slackMsgs) => {
          for (const adapterCase of multiConversationCases) {
            const payload = adapterCase.payload(convos);
            expect(adapterCase.parse(payload, adapterCase.filePath)).toEqual(adapterCase.parse(payload, adapterCase.filePath));
          }
          const slack = slackPayload(slackMsgs);
          expect(parseSlackConversations(slack, SLACK_FILE)).toEqual(parseSlackConversations(slack, SLACK_FILE));
        }
      )
    );
  });
});
