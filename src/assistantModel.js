import { getClient } from './aiCoach.js';
import { config } from './config.js';

/**
 * The model side both WhatsApp receptionists share: Gemini on Vertex AI with
 * tool calling, and the grounding check that keeps a made-up price out of a
 * reply. Each vertical brings its own system instruction, tools and data
 * (src/coaching/receptionistAi.js, src/gymReceptionistAi.js); the exchange
 * and the guard are the same for both.
 *
 * The prompt asks for grounding; checkGrounding() enforces the part that
 * matters most. A rupee amount in the reply that appears nowhere in the data
 * the model was given is sent back once to be corrected, and if it survives
 * that, the contact gets the vertical's holding message and the desk gets
 * the chat.
 */

const MAX_ROUNDS = 6;
const MAX_REPLY_CHARS = 1500;

/* ── Grounding ───────────────────────────────────────────────────────── */

const NUMBER_IN_TEXT = /\d[\d,]*(?:\.\d+)?/g;
const toNumber = (s) => Number(String(s).replace(/,/g, ''));

/** Every number anywhere in `value` (object, array, string), into `into`. */
export function collectNumbers(value, into = new Set()) {
  if (value === null || value === undefined) return into;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(value);
  } else if (typeof value === 'string') {
    for (const m of value.match(NUMBER_IN_TEXT) ?? []) {
      const n = toNumber(m);
      if (Number.isFinite(n)) into.add(n);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
  } else if (typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, into);
  }
  return into;
}

const MULTIPLIER = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3 };
const SCALE = '(?:\\s*(lakhs?|lacs?|l|k|thousand|hazaa?r)\\b)?';
const AMOUNT_PATTERNS = [
  // ₹45,000 · Rs. 45000 · INR 1.2 lakh
  new RegExp(`(?:₹|\\brs\\.?|\\binr\\b)\\s*(\\d[\\d,]*(?:\\.\\d+)?)${SCALE}`, 'gi'),
  // 45,000/- · 45000 rupees · 1.2 lakh rupaye · 45000 rs
  new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)${SCALE}\\s*(?:\\/-|rupees?|rupaye|rupay|rs\\b)`, 'gi'),
];

/** The money amounts a reply quotes, as plain numbers. */
export function amountsIn(text) {
  const found = [];
  for (const re of AMOUNT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) {
      const base = toNumber(m[1]);
      if (!Number.isFinite(base)) continue;
      found.push(base * (MULTIPLIER[(m[2] || '').toLowerCase()] ?? 1));
    }
  }
  return [...new Set(found)];
}

/** Amounts in `text` that appear nowhere in the data the model was given. */
export function checkGrounding(text, grounded) {
  return amountsIn(text).filter((amount) => ![...grounded].some((g) => Math.abs(g - amount) < 0.5));
}

const FOLLOW_UP_WORD = /\b(contact|call|reply|get back|follow[- ]?up|baat|sampark|confirm|reach out|bata(?:yegi|yenge|egi|enge)?|help kar(?:egi|enge|ega))\b/i;

/**
 * Whether a reply tells the contact a person will get back to them — a
 * sentence naming one of `teamWord`'s people and a follow-up verb. The model
 * is asked to call handoff_to_staff whenever it says so, and often does not;
 * a promise made on WhatsApp must reach the desk either way.
 */
export function promisesFollowUp(reply, teamWord) {
  return String(reply || '')
    .split(/[.!?\n]+/)
    .some((sentence) => teamWord.test(sentence) && FOLLOW_UP_WORD.test(sentence));
}

/** Markdown the model may still write, turned into WhatsApp's own. */
export function toWhatsApp(text) {
  let out = String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > MAX_REPLY_CHARS) {
    const cut = out.slice(0, MAX_REPLY_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('? '));
    out = (end > MAX_REPLY_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim();
  }
  return out;
}

/* ── The exchange ────────────────────────────────────────────────────── */

/** Appends a text turn, merging into the previous one of the same role —
 * the API wants user and model to alternate. */
function pushText(contents, role, text) {
  const last = contents.at(-1);
  if (last && last.role === role && last.parts.every((p) => typeof p.text === 'string')) {
    last.parts.push({ text });
    return;
  }
  contents.push({ role, parts: [{ text }] });
}

/**
 * Builds the conversation for the model: the chat so far (the contact's
 * turns as the user, the assistant's and staff's as the model), then the
 * live data and the new messages as the latest user turn.
 *
 * `labels` names things the vertical's way: `org` ("institute"), `dataName`
 * ("INSTITUTE DATA") and `contact` ("parent").
 */
export function buildContents({ history = [], data, newMessages, labels }) {
  const contents = [];
  for (const turn of history) {
    if (turn.author === 'parent') pushText(contents, 'user', turn.body);
    else if (turn.author === 'ai') pushText(contents, 'model', turn.body);
    else if (turn.author === 'staff') pushText(contents, 'model', `[Reply typed by the ${labels.org}'s staff] ${turn.body}`);
  }
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: `(The ${labels.org} started this chat.)` }] });
  pushText(
    contents,
    'user',
    `${labels.dataName} (live from the ${labels.org}'s system):\n${JSON.stringify(data)}\n\nNEW MESSAGES FROM THE ${labels.contact.toUpperCase()} (oldest first):\n${newMessages.map((m) => `- ${m}`).join('\n')}`,
  );
  return contents;
}

const addUsage = (total, usage = {}) => {
  total.input_tokens += usage.promptTokenCount ?? 0;
  total.output_tokens += (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
};

/**
 * One reply on WhatsApp. `executeTool(name, args)` runs a tool against the
 * tenant's database and returns a plain object for the model.
 *
 * Resolves to { reply, toolCalls, guarded, usage }. `guarded` means the
 * model's own answer was withheld for quoting an ungrounded amount and the
 * reply is `fallbackReply`. Throws on a timeout, a provider error, an empty
 * reply or a runaway tool loop; the caller sends the holding message then.
 */
export async function runAssistant({ systemInstruction, tools, history, data, newMessages, labels, fallbackReply, executeTool, signal }) {
  const ai = await getClient();
  const contents = buildContents({ history, data, newMessages, labels });
  const grounded = collectNumbers(data);
  const toolCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const timeout = AbortSignal.timeout(config.aiReceptionist.timeoutMs);
  const abortSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let corrected = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: config.aiReceptionist.model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: tools }],
        temperature: 0.2,
        maxOutputTokens: 4096,
        // Enough to pick the right tool and slot; someone is waiting.
        thinkingConfig: { thinkingBudget: 512 },
        abortSignal,
      },
    });
    addUsage(usage, response?.usageMetadata);
    const modelTurn = response?.candidates?.[0]?.content;
    const calls = response?.functionCalls ?? [];

    if (calls.length) {
      // The model's turn goes back exactly as it came — on thinking models it
      // carries the signatures the next round is checked against.
      contents.push(modelTurn ?? { role: 'model', parts: calls.map((functionCall) => ({ functionCall })) });
      const parts = [];
      for (const call of calls) {
        let result;
        try {
          result = await executeTool(call.name, call.args ?? {});
        } catch (err) {
          result = { ok: false, error: err.message || 'That did not work.' };
        }
        collectNumbers(result, grounded);
        toolCalls.push({ name: call.name, args: call.args ?? {}, result });
        parts.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: result } });
      }
      contents.push({ role: 'user', parts });
      continue;
    }

    const reply = toWhatsApp(response?.text);
    if (!reply) throw new Error('The assistant returned an empty reply');
    const ungrounded = checkGrounding(reply, grounded);
    if (!ungrounded.length) return { reply, toolCalls, guarded: false, usage };
    if (corrected) return { reply: fallbackReply, toolCalls, guarded: true, ungrounded, draft: reply, usage };
    corrected = true;
    contents.push(modelTurn ?? { role: 'model', parts: [{ text: reply }] });
    contents.push({
      role: 'user',
      parts: [
        {
          text: `SYSTEM CHECK (not from the ${labels.contact}): your reply quotes ${ungrounded
            .map((a) => `₹${a.toLocaleString('en-IN')}`)
            .join(', ')}, which is not in ${labels.dataName} or any tool result. Rewrite the reply using only amounts that appear in the data, exactly as written there. If the ${labels.contact} needs a figure the data does not have, say the team will confirm it and call handoff_to_staff.`,
        },
      ],
    });
  }
  throw new Error('The assistant did not finish its reply');
}
