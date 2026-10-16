import { config } from './config.js';
import { all, get } from './db.js';
import { MEAL_TYPES, MUSCLE_GROUPS, exerciseHistory } from './fitness.js';
import { ageOn, effectiveDietTargets, exerciseForDay, nutritionProfile, weightOn } from './nutrition.js';
import { addDays, today } from './validate.js';

/**
 * Ask Coach: the member app's chat, answered by Gemini on Google Vertex AI.
 *
 * What makes it worth more than asking a general assistant is the context
 * built here: the member's sex, age, bodyweight, goal and injuries, the plan
 * they are on, every set of the session in front of them, and how each of
 * those exercises went the last few times — read from the gym's own database,
 * never typed in. Kept compact (a couple of thousand tokens) because every
 * question pays for it.
 *
 * The next-set chip on the set table does not come through here: that is
 * public/js/nextSet.js, worked out on the phone for free.
 */

export const COACH_SCREENS = ['workout', 'diet'];
export const MAX_QUESTION_LENGTH = 500;
/** Earlier turns from the last day sent back as the chat's memory. */
const HISTORY_TURNS = 6;
const MAX_SESSION_EXERCISES = 15;
const MAX_SESSION_SETS = 12;
const HISTORY_EXERCISES = 8;
/** Exercises one question may name with @ (the app's exercise picker). */
const MAX_MENTIONS = 5;
/** A meal plan's size: a whole day is at most six meals of a few foods each. */
const MAX_PLAN_MEALS = 6;
const MAX_MEAL_ITEMS = 8;
/** Swap candidates per muscle group in the session: enough choice of
 * equipment and angle without paying for the whole library on every question. */
const MAX_SWAP_OPTIONS = 20;

export const coachConfigured = () => Boolean(config.aiCoach.project);

let client = null;
let testClient = null;

/** Swaps the Gemini client for a stub in tests: anything with
 * `models.generateContent(params)`; pass null to restore the real one. */
export function setAiClientForTests(fake) {
  testClient = fake;
}

async function getClient() {
  if (testClient) return testClient;
  if (!client) {
    // Loaded on first use, so a server without the coach configured never
    // pulls in Google's SDK at all.
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({
      vertexai: true,
      project: config.aiCoach.project,
      location: config.aiCoach.location,
    });
  }
  return client;
}

const SYSTEM_INSTRUCTION = `You are the personal coach inside a gym's member app. You answer one member's questions about their training and nutrition while they are in the gym, often between sets, so be quick and concrete.

You are given MEMBER CONTEXT as JSON: their profile, injuries or limitations, current plan, the live workout session (every set so far with weight, reps and effort as RPE), recent history for those exercises, the last week of workouts, and today's food against their targets. Weights in the context are kilograms; "unit" is what the member uses, so give every weight in that unit, rounded to what a gym actually has. The smallest plate is 2.5 kg, so a barbell or Smith machine only goes up or down in 5 kg steps (a 2.5 kg plate on each side); dumbbells go in 2.5 kg steps; pounds go in 5 lb steps. Never suggest 1.25 kg plates or any load that needs them, such as 32.5 kg on a bar. When the next 5 kg step is too big a jump, say add reps at the same weight first. An exercise in the session with "weight_step" overrides all of that for that exercise: it is the jump the member's own kit makes, learned from what they have logged (a stack that goes 6.5, 13, 19.5 kg, or a gym with 1.25 kg plates), so only suggest weights on that step.

How to answer:
- 2 to 5 short sentences. Lead with the answer (a number, a choice), then the one reason that matters. No headings and no lists in the answer.
- Wrap the numbers the member acts on in **double asterisks** (e.g. "**2413 calories, 82g protein** left"); no other markdown. A blank line may split the answer into two short paragraphs.
- Use their actual numbers. Prefer the context to generic advice; say so when there is no history to go on.
- An exercise written with @ ("@Incline Dumbbell Press") was picked from the member's workout or plan: the question is about that exercise, even when it is not the one marked "current" or is on another day of the plan. "asked_about" lists them, and their past sets are in "exercise_history".
- For "what weight/reps next", work from the set they just did: below the target rep range or a failed set means go lighter; past the top of the range or an easy set means go heavier; otherwise hold. "next_set_suggestion" in the session is the app's own rule-based pick — agree with it or explain why you differ.
- When you recommend a specific next set for one exercise in the session, also fill "suggestion" with that exercise's exact name, the weight in kilograms and the reps. Leave it out for anything else.
- Swaps: when the member asks for a swap, a replacement or an alternative for an exercise in the session (or one is the right call, say for pain or a busy machine), pick ONE replacement from "swap_options" under that exercise's muscle group, copying its name exactly, and fill "swap" with "from" (the session exercise's exact name) and "to". "This exercise" means the one marked "current", unless the question names one with @. Respect limitations, and prefer a different piece of equipment or angle from the one being replaced. The answer names the swap and gives the one reason; the app shows a button that makes the swap. Leave "swap" out for anything else.
- Be conservative around anything listed under limitations and around pain: suggest a lighter or alternative movement and seeing a trainer or doctor. Never diagnose or treat medical conditions, and never recommend drugs, supplements beyond basics like protein or creatine, or extreme diets.
- Stay on fitness, exercise, recovery and nutrition. Politely decline anything else.
- Answer in the language the member writes in. Many members write Hinglish — Hindi in Roman letters mixed with English ("bhai next set mein kitna weight lagaun?"); answer them in the same casual Hinglish in Roman letters, keeping exercise names, units and numbers in English.

Meal plans — you can and should make them. Whenever the member asks for a meal plan, a diet for the day, what to eat, or a meal or snack idea, fill "meal_plan"; the app shows it as a card they can save and then track food by food from the food library. Never say you cannot make a meal plan.
- Scope: "a meal plan" or "rest of today" covers the meals still to come today, fitted to what is left (targets minus eaten; skip meal types in "meals_logged"). If nothing is eaten yet, or they ask for a full day or tomorrow, plan the whole day against the full targets. A single meal or snack idea is a meal_plan with just that one meal.
- Land the plan's total within about 10% of the calories and protein it is meant to cover. Hitting protein matters most.
- Real, everyday foods with a concrete portion each ("150 g", "2 eggs", "1 cup cooked", "1 medium banana"). The member searches a food database for each food_name, so name the plain food the way a database does ("Chicken breast", "Rolled oats", "Paneer", "Brown rice"); put how it is cooked in the portion ("150 g, grilled"), not the name. No brackets or second names in food_name: "Paneer", not "Paneer (Cottage Cheese)". Give each food's calories, protein, carbs and fats for that portion from standard nutrition values; calories should be close to 4 × protein + 4 × carbs + 9 × fats.
- meal_type is one of breakfast, lunch, dinner, snack, pre_workout, post_workout. 2 to 5 foods per meal.
- Follow any diet, cuisine, allergy or food the member mentions now or earlier (vegetarian, no eggs, Indian food) and their limitations.
- With a meal_plan, "answer" is 1 to 3 sentences: what the plan covers and how its total sits against what is left, with the key numbers in bold. Do not list the foods in the answer — the card shows them.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The reply shown to the member.' },
    suggestion: {
      type: 'object',
      description: 'Only when recommending a specific next set for one exercise in the live session.',
      properties: {
        exercise: { type: 'string' },
        weight_kg: { type: 'number', minimum: 0 },
        reps: { type: 'integer', minimum: 1 },
      },
      required: ['exercise', 'weight_kg', 'reps'],
    },
    swap: {
      type: 'object',
      description: 'Only when suggesting one exercise in the live session be replaced by another from swap_options.',
      properties: {
        from: { type: 'string', description: 'The exact name of the exercise in the live session.' },
        to: { type: 'string', description: 'The exact name of the replacement, copied from swap_options.' },
      },
      required: ['from', 'to'],
    },
    // No minItems/maxItems on the nested lists (Vertex rejects them with a
    // 400); cleanMealPlan enforces the counts.
    meal_plan: {
      type: 'object',
      description: 'Only when the member asks for a meal plan, what to eat, or a meal or snack idea.',
      properties: {
        name: { type: 'string', description: 'Short title, at most 40 characters, e.g. "High-protein rest of today".' },
        meals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              meal_type: { type: 'string', enum: MEAL_TYPES },
              name: { type: 'string', description: 'Optional dish name, e.g. "Chicken rice bowl".' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    food_name: { type: 'string' },
                    portion: { type: 'string', description: 'e.g. "150 g", "2 eggs", "1 cup cooked".' },
                    calories: { type: 'integer', minimum: 0 },
                    protein_g: { type: 'number', minimum: 0 },
                    carbs_g: { type: 'number', minimum: 0 },
                    fats_g: { type: 'number', minimum: 0 },
                  },
                  required: ['food_name', 'portion', 'calories', 'protein_g', 'carbs_g', 'fats_g'],
                },
              },
            },
            required: ['meal_type', 'items'],
          },
        },
      },
      required: ['name', 'meals'],
    },
  },
  required: ['answer'],
};

/* ── Context ──────────────────────────────────────────────────────────── */

const num = (value, max = 10000) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
};
const text = (value, max = 80) => String(value ?? '').trim().slice(0, max);
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * The live session as the phone sent it, cut down to what the coach needs and
 * coerced to plain numbers and short strings — it came from the client, so
 * nothing in it is trusted beyond being shown to the model.
 */
export function sanitiseSession(session) {
  if (!session || typeof session !== 'object' || !Array.isArray(session.exercises)) return null;
  return {
    workout_name: text(session.workout_name),
    elapsed_minutes: Math.round(num(session.elapsed_seconds, 86400) / 60),
    exercises: session.exercises.slice(0, MAX_SESSION_EXERCISES).map((exercise) => ({
      name: text(exercise?.name),
      muscle_group: text(exercise?.muscle_group, 30) || undefined,
      equipment: text(exercise?.equipment, 30) || undefined,
      // The one the member is on: what "this exercise" means.
      current: exercise?.current ? true : undefined,
      target: exercise?.target_reps ? `${num(exercise.target_sets, 20)} × ${text(exercise.target_reps, 20)}` : undefined,
      rest_seconds: exercise?.rest_seconds == null ? undefined : num(exercise.rest_seconds, 900),
      sets: (Array.isArray(exercise?.sets) ? exercise.sets : []).slice(0, MAX_SESSION_SETS).map((set) => ({
        type: ['warmup', 'normal', 'drop', 'failure'].includes(set?.set_type) ? set.set_type : 'normal',
        kg: round1(num(set?.weight_kg, 1000)),
        reps: num(set?.reps, 500),
        rpe: set?.rpe == null || set.rpe === '' ? undefined : num(set.rpe, 10),
        done: Boolean(set?.completed),
      })),
      next_set_suggestion: exercise?.suggestion
        ? { kg: round1(num(exercise.suggestion.weight_kg, 1000)), reps: num(exercise.suggestion.reps, 500) }
        : undefined,
      // The jump this member's kit makes, learned from their logs ("6.5 kg").
      weight_step: text(exercise?.weight_step, 20) || undefined,
    })),
  };
}

const nameKey = (name) => String(name ?? '').trim().toLowerCase();

/** The exercises a question named with @, as the phone sent them: a few
 * short, distinct names, or null. */
export function sanitiseMentions(mentions) {
  if (!Array.isArray(mentions)) return null;
  const seen = new Set();
  const names = [];
  for (const raw of mentions) {
    const name = typeof raw === 'string' ? text(raw) : '';
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push(name);
    if (names.length === MAX_MENTIONS) break;
  }
  return names.length ? names : null;
}

/**
 * What each muscle group in the live session could be swapped for, from the
 * gym's own library, as "name | equipment" — so a swap the coach suggests is
 * one the app can put straight into the workout. Exercises already in the
 * session are left out.
 */
export function swapOptions(live, library) {
  if (!live?.exercises?.length || !library?.length) return null;
  const byName = new Map(library.map((item) => [nameKey(item.name), item]));
  const inSession = new Set(live.exercises.map((exercise) => nameKey(exercise.name)));
  const groups = new Set(
    live.exercises.map((exercise) => byName.get(nameKey(exercise.name))?.muscle_group ?? exercise.muscle_group).filter(Boolean),
  );
  const options = {};
  for (const group of groups) {
    const lines = library
      .filter((item) => item.muscle_group === group && !inSession.has(nameKey(item.name)))
      .slice(0, MAX_SWAP_OPTIONS)
      .map((item) => `${item.name} | ${item.equipment ?? 'other'}`);
    if (lines.length) options[group] = lines;
  }
  return Object.keys(options).length ? options : null;
}

/** The last few sessions of one exercise, one line each: "2026-10-09: 30×10, 30×9 @9". */
function historyLines(memberId, name) {
  const { sessions } = exerciseHistory(memberId, name, { limit: 3 });
  return sessions.map((session) => {
    const sets = session.sets
      .filter((set) => set.set_type !== 'warmup')
      .map((set) => (set.weight_kg > 0 ? `${round1(set.weight_kg)}×${set.reps}` : `${set.reps} reps`))
      .join(', ');
    return `${session.log_date}: ${sets || 'no working sets'}`;
  });
}

/**
 * Everything the coach is told about this member. Only this member's rows are
 * read — memberId comes from their verified session, never the request body.
 */
export function buildCoachContext(memberId, { screen, session, unit, planId, library, mentions }) {
  const on = today();
  const member = get('SELECT first_name, gender, date_of_birth, health_notes FROM members WHERE id = ?', [memberId]) ?? {};
  const profile = nutritionProfile(memberId);
  const weightNow = weightOn(memberId, on);
  const weightMonthAgo = get(
    'SELECT weight_kg FROM body_weight_logs WHERE member_id = ? AND log_date <= ? ORDER BY log_date DESC LIMIT 1',
    [memberId, addDays(on, -30)],
  )?.weight_kg;

  const plan = planId
    ? get('SELECT name, goal, level, days_per_week FROM workout_plans WHERE id = ?', [planId])
    : null;

  const recent = all(
    `SELECT l.id, l.log_date, l.workout_name, l.total_volume_kg, l.total_sets, l.duration_seconds,
            (SELECT GROUP_CONCAT(DISTINCT s.muscle_group) FROM workout_log_sets s WHERE s.log_id = l.id) AS muscles
     FROM workout_logs l
     WHERE l.member_id = ? AND l.log_date >= ?
     ORDER BY l.log_date DESC, l.id DESC
     LIMIT 10`,
    [memberId, addDays(on, -7)],
  ).map((log) => ({
    date: log.log_date,
    name: log.workout_name,
    sets: log.total_sets,
    volume_kg: Math.round(log.total_volume_kg),
    minutes: Math.round((log.duration_seconds ?? 0) / 60),
    muscles: log.muscles ? log.muscles.split(',') : [],
  }));

  const live = sanitiseSession(session);
  const history = {};
  for (const exercise of (live?.exercises ?? []).slice(0, HISTORY_EXERCISES)) {
    if (!exercise.name) continue;
    const lines = historyLines(memberId, exercise.name);
    if (lines.length) history[exercise.name] = lines;
  }
  // Exercises picked with @ get their history too, wherever in the plan they are.
  const askedAbout = sanitiseMentions(mentions);
  for (const name of askedAbout ?? []) {
    if (Object.keys(history).some((key) => nameKey(key) === nameKey(name))) continue;
    const lines = historyLines(memberId, name);
    if (lines.length) history[name] = lines;
  }

  const { targets } = effectiveDietTargets(memberId);
  const food = get(
    `SELECT COALESCE(SUM(e.calories), 0) AS calories, COALESCE(SUM(e.protein_g), 0) AS protein_g,
            COALESCE(SUM(e.carbs_g), 0) AS carbs_g, COALESCE(SUM(e.fats_g), 0) AS fats_g, COUNT(e.id) AS items
     FROM diet_logs d LEFT JOIN diet_log_entries e ON e.diet_log_id = d.id
     WHERE d.member_id = ? AND d.log_date = ?`,
    [memberId, on],
  ) ?? { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0, items: 0 };
  const burned = exerciseForDay(memberId, on).total_burned;
  // So "a meal plan for the rest of today" can skip the meals already eaten.
  const mealsLogged = all(
    `SELECT DISTINCT e.meal_type FROM diet_logs d JOIN diet_log_entries e ON e.diet_log_id = d.id
     WHERE d.member_id = ? AND d.log_date = ?`,
    [memberId, on],
  ).map((row) => row.meal_type);

  return {
    today: on,
    screen,
    unit: unit === 'lb' ? 'lb' : 'kg',
    member: {
      first_name: member.first_name ?? null,
      sex: profile.sex ?? null,
      age: ageOn(profile.birth_date, on),
      height_cm: profile.height_cm ?? null,
      bodyweight_kg: weightNow ?? null,
      bodyweight_change_30d_kg: weightNow != null && weightMonthAgo != null ? round1(weightNow - weightMonthAgo) : null,
      goal: profile.goal,
      goal_rate_kg_per_week: profile.goal_rate_kg,
      goal_weight_kg: profile.goal_weight_kg ?? null,
      activity_level: profile.activity_level,
      training_days_per_week: profile.training_days,
      limitations: text(member.health_notes, 400) || null,
    },
    plan: plan ? { name: plan.name, goal: plan.goal, level: plan.level, days_per_week: plan.days_per_week } : null,
    live_session: live,
    // Mid-workout only, with the gym's library to pick from.
    ...(screen === 'workout' && { swap_options: swapOptions(live, library) ?? undefined }),
    ...(askedAbout && { asked_about: askedAbout }),
    exercise_history: history,
    last_7_days: recent,
    diet_today: {
      eaten: {
        calories: Math.round(food.calories),
        protein_g: Math.round(food.protein_g),
        carbs_g: Math.round(food.carbs_g),
        fats_g: Math.round(food.fats_g),
      },
      items_logged: food.items,
      meals_logged: mealsLogged,
      targets: {
        calories: targets.target_calories,
        protein_g: targets.target_protein_g,
        carbs_g: targets.target_carbs_g,
        fats_g: targets.target_fats_g,
      },
      burned_exercise_kcal: Math.round(burned),
    },
  };
}

/* ── Asking ───────────────────────────────────────────────────────────── */

/** This member's questions in the last 24 hours — the cap is a rolling day,
 * like plan sharing's, so it never depends on which timezone "today" is in. */
export function questionsToday(memberId) {
  return get(
    "SELECT COUNT(*) AS n FROM ai_coach_messages WHERE member_id = ? AND created_at >= datetime('now', '-1 day')",
    [memberId],
  ).n;
}

/** The last few exchanges on the same screen, oldest first, as chat turns. */
export function recentTurns(memberId, screen) {
  return all(
    `SELECT question, answer, meal_plan FROM ai_coach_messages
     WHERE member_id = ? AND screen = ? AND created_at >= datetime('now', '-1 day')
     ORDER BY id DESC LIMIT ?`,
    [memberId, screen, HISTORY_TURNS],
  ).reverse();
}

/** The generateContent params for one question, shared by the plain and the
 * streamed ask. `signal` cuts the call short besides the timeout. */
function coachParams({ context, question, history, signal }) {
  const contents = [];
  for (const turn of history) {
    contents.push({ role: 'user', parts: [{ text: turn.question }] });
    // The plan goes back too, so "make the dinner vegetarian" has something to change.
    const reply = { answer: turn.answer };
    if (turn.meal_plan) {
      try {
        reply.meal_plan = JSON.parse(turn.meal_plan);
      } catch {}
    }
    contents.push({ role: 'model', parts: [{ text: JSON.stringify(reply) }] });
  }
  // The context rides on the newest question rather than in the system
  // instruction, so it is always the live state — the session has moved on
  // since the last question.
  contents.push({
    role: 'user',
    parts: [{ text: `MEMBER CONTEXT:\n${JSON.stringify(context)}\n\nQUESTION:\n${question}` }],
  });
  const timeout = AbortSignal.timeout(config.aiCoach.timeoutMs);
  return {
    model: config.aiCoach.model,
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      // On thinking models the thinking counts against this too: a question
      // with arithmetic in it (a meal that fits today's macros) can think for
      // ~1000 tokens, and at 1024 the JSON was cut off mid-answer. A whole
      // day's meal plan adds ~1500 more. Only what is written is billed.
      maxOutputTokens: 8192,
      // Left unbounded, thinking on that same meal question ran past the
      // timeout instead of being cut off.
      thinkingConfig: { thinkingBudget: 1024 },
      abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    },
  };
}

const usageOf = (usage = {}) => ({
  input_tokens: usage.promptTokenCount ?? 0,
  output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
});

/**
 * One question to Gemini. Resolves to { answer, suggestion, input_tokens,
 * output_tokens }; throws on a timeout, a provider error or a reply that is
 * not the JSON asked for — the route turns all of those into one friendly 502.
 */
export async function askCoach({ context, question, history = [] }) {
  const ai = await getClient();
  const response = await ai.models.generateContent(coachParams({ context, question, history }));
  return { ...parseReply(response?.text), ...usageOf(response?.usageMetadata) };
}

/**
 * The same question, streamed: Gemini's thought summaries go to onThought and
 * the answer to onAnswer as each piece arrives, so the sheet can show the
 * coach thinking and then typing. The reply is still the JSON askCoach gets —
 * onAnswer is fed the "answer" string read out of it while it is being
 * written. Resolves and throws exactly like askCoach.
 */
export async function streamCoach({ context, question, history = [], signal, onThought, onAnswer }) {
  const ai = await getClient();
  const params = coachParams({ context, question, history, signal });
  params.config.thinkingConfig = { ...params.config.thinkingConfig, includeThoughts: true };
  const stream = await ai.models.generateContentStream(params);

  let raw = '';
  let sent = 0;
  let usage;
  for await (const chunk of stream) {
    if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) {
        onThought?.(part.text);
        continue;
      }
      raw += part.text;
      const soFar = partialAnswer(raw);
      if (soFar.length > sent) {
        onAnswer?.(soFar.slice(sent));
        sent = soFar.length;
      }
    }
  }
  return { ...parseReply(raw), ...usageOf(usage) };
}

/* ── Voice questions ──────────────────────────────────────────────────── */

/** What the phone's recorder makes: Chrome, Edge and Firefox record WebM or
 * Ogg Opus, Safari MP4 (AAC). The codecs part of a type is dropped first. */
export const VOICE_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav'];
/** The phone stops at a minute: about 250 KB of Opus, 1 MB of AAC. */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

const TRANSCRIBE_INSTRUCTION = `You write down a gym member's spoken question to their AI coach, word for word, so it can go into the chat box. You never answer it.

- The member may speak any language. Write it in the language spoken; never translate it.
- Hindi, and Hinglish (Hindi mixed with English, the way people talk in Indian gyms), are ALWAYS written in Roman letters, never Devanagari, the way people type them on WhatsApp: "bhai next set mein kitna weight lagaun?", "aaj protein kam reh gaya, dinner mein kya khaun?". English words keep their English spelling. Every other language uses its usual script.
- Numbers as digits, with the usual units: "20 kg", "3 sets of 12", "2 roti".
- Spell gym and food words properly: bench press, RDL, RPE, reps, whey, paneer, roti, dal, poha.
- Add punctuation, but do not add, drop or tidy up words. Leave out filler sounds (um, uh, hmm, matlab when it is filler).
- The phone is in a gym: expect music, clanking weights and other people. The member is the nearest, clearest voice — write that down and ignore song lyrics and background chatter. Faint, fast, accented or partly drowned-out speech still gets your best reading; never leave out words you can make out.
- "text" is empty ONLY when the member says nothing at all.`;

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'What the member said, or "" when nothing clear was said.' } },
  required: ['text'],
};

/** The transcript out of Gemini's JSON, as one line no longer than a typed
 * question may be. Throws on anything that is not the JSON asked for. */
export function parseTranscript(raw) {
  const parsed = JSON.parse(stripCodeFences(String(raw ?? '')));
  if (typeof parsed?.text !== 'string') throw new Error('Transcript reply has no text');
  return parsed.text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_LENGTH);
}

/**
 * A recorded question as text, for the member to check and send. `audio` is
 * base64; `screen` tells Gemini which words to expect. Resolves to { text,
 * input_tokens, output_tokens }, text '' when nothing was said; throws like
 * askCoach.
 */
export async function transcribeVoice({ audio, mimeType, screen }) {
  const ai = await getClient();
  const topic = screen === 'diet' ? 'food, meals and macros' : 'the workout in front of them';
  const response = await voiceCall(ai, TRANSCRIBE_INSTRUCTION, [
    { inlineData: { mimeType, data: audio } },
    { text: `The member is asking about ${topic}. Write down what they said — Hindi or Hinglish in Roman letters.` },
  ]);
  const usage = usageOf(response?.usageMetadata);
  let text = parseTranscript(response?.text);
  // Now and then — most often over music — Gemini writes Hindi in Devanagari
  // despite the instruction, and the coach would answer in Devanagari too.
  // Rewriting the script is a cheap text-only call; if it fails, the
  // Devanagari is still a usable question.
  if (DEVANAGARI.test(text)) {
    try {
      const rewrite = await voiceCall(ai, ROMANISE_INSTRUCTION, [{ text }]);
      // Billed whether or not its reply is usable.
      const more = usageOf(rewrite?.usageMetadata);
      usage.input_tokens += more.input_tokens;
      usage.output_tokens += more.output_tokens;
      text = parseTranscript(rewrite?.text) || text;
    } catch (err) {
      console.error('Coach voice: could not rewrite Devanagari in Roman letters:', err?.message ?? err);
    }
  }
  return { text, ...usage };
}

/** Voice clips this member had written down in the last day: the voice cap. */
export function voiceClipsToday(memberId) {
  return get(
    "SELECT COUNT(*) AS n FROM ai_voice_transcriptions WHERE member_id = ? AND created_at >= datetime('now', '-1 day')",
    [memberId],
  ).n;
}

const DEVANAGARI = /[ऀ-ॿ]/;

const ROMANISE_INSTRUCTION = `You are given a gym member's question in Hindi or Hinglish written in Devanagari. Rewrite it in Roman letters the way people type Hinglish on WhatsApp ("aaj protein kam reh gaya, dinner mein kya khaun?"), with English words (protein, dinner, bench press, reps) in their English spelling. Change only the script: never translate, shorten or answer it. Anything already in Roman letters stays as it is.`;

/** A transcript usually comes back in 2–8 s, so one stuck past this is
 * retried rather than left spinning for the chat's 45 s. */
const VOICE_TIMEOUT_MS = 15_000;
const VOICE_RETRY_MS = 1500;
const isRateLimited = (err) => err?.status === 429 || /RESOURCE_EXHAUSTED/.test(String(err?.message ?? ''));
const isTimeout = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError' || /aborted/i.test(String(err?.message ?? ''));

/** One short JSON { text } call for the voice path. Vertex's shared capacity
 * turns away a burst with a 429 that clears in a second or two, and the odd
 * call stalls: either way one more try beats making the member say it again. */
async function voiceCall(ai, systemInstruction, parts) {
  const params = () => ({
    model: config.aiCoach.model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: TRANSCRIBE_SCHEMA,
      temperature: 0,
      maxOutputTokens: 1024,
      // Writing down is not reasoning; the smallest budget every model takes.
      thinkingConfig: { thinkingBudget: 128 },
      abortSignal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    },
  });
  try {
    return await ai.models.generateContent(params());
  } catch (err) {
    if (!isRateLimited(err) && !isTimeout(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, VOICE_RETRY_MS));
    return ai.models.generateContent(params());
  }
}

const JSON_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * The "answer" string out of a JSON reply that may still be arriving: as much
 * of it as is complete, unescaped. An escape cut off at the end waits for the
 * next chunk rather than showing a stray backslash.
 */
export function partialAnswer(raw) {
  const start = /"answer"\s*:\s*"/.exec(raw);
  if (!start) return '';
  let out = '';
  for (let i = start.index + start[0].length; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += JSON_ESCAPES[next] ?? next;
      i += 1;
    }
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the coach is looking at for this question, as the short lines the
 * sheet ticks off while Gemini works — read from the context actually sent,
 * so they are never just for show.
 */
export function contextSteps(context) {
  const steps = ['Reading your profile and goal'];
  const live = context.live_session;
  if (context.screen === 'workout' && live?.exercises?.length) {
    const done = live.exercises.reduce((n, exercise) => n + exercise.sets.filter((set) => set.done).length, 0);
    steps.push(`Reading this session — ${plural(live.exercises.length, 'exercise')}, ${plural(done, 'set')} done`);
  }
  if (context.asked_about?.length) steps.push(`Looking at ${context.asked_about.join(' and ')}`);
  const names = Object.keys(context.exercise_history ?? {});
  if (names.length) {
    const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
    steps.push(`Checking your last sessions of ${names.slice(0, 2).join(' and ')}${more}`);
  }
  const week = context.last_7_days?.length ?? 0;
  steps.push(week ? `Looking back at ${plural(week, 'workout')} this week` : 'No workouts logged this week yet');
  if (context.plan?.name) steps.push(`Following your plan, ${context.plan.name}`);
  const diet = context.diet_today;
  if (context.screen === 'diet' && diet) {
    steps.push(
      diet.targets?.calories
        ? `Comparing today's food with your targets — ${diet.eaten.calories} of ${diet.targets.calories} kcal`
        : `Adding up today's food — ${diet.eaten.calories} kcal so far`,
    );
  }
  if (context.member?.limitations) steps.push('Keeping your injury notes in mind');
  return steps;
}

function stripCodeFences(str) {
  const text = String(str ?? '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

/* ── Meal plans ───────────────────────────────────────────────────────── */

/** A plan's calories and macros, summed from its foods. */
export function mealPlanTotals(meals) {
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 };
  for (const meal of meals) {
    for (const item of meal.items) {
      totals.calories += item.calories;
      totals.protein_g += item.protein_g;
      totals.carbs_g += item.carbs_g;
      totals.fats_g += item.fats_g;
    }
  }
  return { calories: totals.calories, protein_g: round1(totals.protein_g), carbs_g: round1(totals.carbs_g), fats_g: round1(totals.fats_g) };
}

/**
 * A meal plan cut to the shape the app logs and saves: known meal types only,
 * every food named with plain non-negative numbers, empty meals dropped.
 * Used on the model's reply and on whatever a phone sends back to log or save,
 * so both are held to the same rules. Null when nothing usable is left.
 */
export function cleanMealPlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.meals)) return null;
  const meals = raw.meals
    .slice(0, MAX_PLAN_MEALS)
    .map((meal) => ({
      meal_type: MEAL_TYPES.includes(meal?.meal_type) ? meal.meal_type : 'snack',
      name: text(meal?.name, 60) || null,
      items: (Array.isArray(meal?.items) ? meal.items : [])
        .slice(0, MAX_MEAL_ITEMS)
        .map((item) => ({
          food_name: text(item?.food_name, 120),
          portion: text(item?.portion, 60) || '1 serving',
          calories: Math.round(num(item?.calories, 5000)),
          protein_g: round1(num(item?.protein_g, 500)),
          carbs_g: round1(num(item?.carbs_g, 1000)),
          fats_g: round1(num(item?.fats_g, 500)),
        }))
        .filter((item) => item.food_name),
    }))
    .filter((meal) => meal.items.length);
  if (!meals.length) return null;
  return { name: text(raw.name, 60) || 'Meal plan', meals, totals: mealPlanTotals(meals) };
}

/** The model's JSON, checked: an answer is required, a suggestion is kept
 * only when every field is a usable number, a meal plan only when it has food. */
export function parseReply(raw) {
  let data;
  const cleaned = stripCodeFences(raw);
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        data = JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    if (!data) throw new Error('Coach reply was not JSON');
  }
  const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
  if (!answer) throw new Error('Coach reply had no answer');
  const s = data.suggestion;
  const suggestion =
    s && typeof s.exercise === 'string' && Number.isFinite(Number(s.weight_kg)) && Number(s.reps) >= 1
      ? { exercise: s.exercise.trim().slice(0, 120), weight_kg: round1(Math.max(0, Number(s.weight_kg))), reps: Math.round(Number(s.reps)) }
      : null;
  const w = data.swap;
  const swap =
    w && typeof w.from === 'string' && typeof w.to === 'string' && w.from.trim() && w.to.trim()
      ? { from: w.from.trim().slice(0, 120), to: w.to.trim().slice(0, 120) }
      : null;
  return { answer: answer.slice(0, 2000), suggestion, swap, meal_plan: cleanMealPlan(data.meal_plan) };
}

/**
 * The model's swap, checked against what is real: "from" must be an exercise
 * in the live session and "to" one in the gym's library, both given back in
 * their own spelling, with the replacement's muscle group. Null otherwise —
 * the answer still says what to do, there is just no button for it.
 */
export function cleanSwap(swap, { session, library }) {
  if (!swap || !library?.length) return null;
  const from = (sanitiseSession(session)?.exercises ?? []).find((exercise) => nameKey(exercise.name) === nameKey(swap.from));
  const to = library.find((item) => nameKey(item.name) === nameKey(swap.to));
  if (!from || !to || nameKey(from.name) === nameKey(to.name)) return null;
  return { from: from.name, to: to.name, muscle_group: to.muscle_group ?? null };
}

/* ── Workout generator ────────────────────────────────────────────────── */

/** What the member picks on the generator sheet. Keys, not prose, so the
 * prompt and the tests see the same few choices. */
export const PLAN_GOALS = ['muscle_gain', 'fat_loss', 'strength', 'endurance', 'general_fitness'];
export const PLAN_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const PLAN_FOCUS = ['balanced', 'upper_body', 'lower_body', 'chest_back', 'arms_shoulders', 'glutes_legs', 'core'];
/** Which of the library's equipment each setting allows. Cardio is in all of
 * them: a treadmill finisher fits any gym that has this app. */
export const PLAN_EQUIPMENT = {
  full_gym: null,
  machines: ['machine', 'cable', 'smith_machine', 'bodyweight', 'cardio'],
  dumbbells: ['dumbbell', 'kettlebell', 'bodyweight', 'band', 'cardio'],
  bodyweight: ['bodyweight', 'band', 'cardio'],
};
const MAX_LIBRARY_LINES = 400;
const MAX_PLAN_EXERCISES_PER_DAY = 12;

/** Generated plans in the last 24 hours. A plan costs several questions'
 * worth of tokens (the whole library rides along), so it has its own cap. */
export function plansToday(memberId) {
  return get(
    "SELECT COUNT(*) AS n FROM ai_plan_generations WHERE member_id = ? AND created_at >= datetime('now', '-1 day')",
    [memberId],
  ).n;
}

const PLAN_INSTRUCTION = `You design weekly gym workout plans for one member of a gym, using ONLY exercises from that gym's EXERCISE LIBRARY.

You get the member's REQUEST (goal, experience, days per week, minutes per session, equipment, focus, notes), their CONTEXT (sex, age, bodyweight, goal, injuries or limitations, the last week of training) and the EXERCISE LIBRARY, one per line as "name | muscle group | equipment".

Rules:
- Every exercise_name must be copied exactly, character for character, from the library. Never invent or rename an exercise.
- Exactly the requested number of days. Name each day for what it trains ("Push", "Pull", "Legs", "Upper A", "Full Body B"), not "Day 1". Pick a split that suits the days: 2-3 days full body; 4 days upper/lower; 5-6 days push/pull/legs or a body-part split.
- Fit each day into the session length: about 4 exercises for 30 minutes, 5-6 for 45-60, 6-8 for 75-90. Compound lifts first, isolation after.
- Sets and reps by goal: strength 3-5 sets of 3-6 reps with 150-240 s rest on compounds; muscle_gain 3-4 sets of 8-12 (isolation 10-15) with 60-120 s rest; fat_loss and endurance 2-4 sets of 12-20 with 30-60 s rest and a short cardio finisher; general_fitness 3 sets of 8-12 with 60-90 s rest. target_reps is a range like "8-12" or a single number.
- Beginners: fewer exercises, more machines and dumbbells, no advanced barbell technique, target_rpe 7. Intermediate 8, advanced 8-9.
- Respect injuries, limitations and the member's notes absolutely: leave out anything that loads an injured area and pick a safe alternative from the library. Mention the swap in that exercise's notes.
- Balance the week: every major muscle group trained at least once (twice for 4+ days), pushes balanced with pulls, and do not put the same muscle group hard on two consecutive days.
- Honour the focus by giving those muscles more volume, while still covering the rest.
- Exercise notes are optional: one short practical cue (form cue, tempo, "superset with the next exercise"). The plan description is 1-2 sentences on how to run the plan and when to add weight.
- Write names, notes and the description in the language of the member's notes; English if there are none.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short plan name, at most 40 characters.' },
    description: { type: 'string' },
    // No minItems/maxItems on these nested lists: Vertex rejects the whole
    // request (400 INVALID_ARGUMENT) when they are there. parsePlanReply
    // enforces the counts instead.
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day_name: { type: 'string' },
          notes: { type: 'string' },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                exercise_name: { type: 'string', description: 'Exactly as written in the EXERCISE LIBRARY.' },
                target_sets: { type: 'integer', minimum: 1, maximum: 8 },
                target_reps: { type: 'string' },
                rest_seconds: { type: 'integer', minimum: 0, maximum: 300 },
                target_rpe: { type: 'number', minimum: 5, maximum: 10 },
                notes: { type: 'string' },
              },
              required: ['exercise_name', 'target_sets', 'target_reps', 'rest_seconds'],
            },
          },
        },
        required: ['day_name', 'exercises'],
      },
    },
  },
  required: ['name', 'days'],
};

/** The library the model may pick from, cut to the member's equipment. */
export function libraryForPlan(items, equipment) {
  const allowed = PLAN_EQUIPMENT[equipment] ?? null;
  return items.filter((item) => !allowed || allowed.includes(item.equipment ?? 'other')).slice(0, MAX_LIBRARY_LINES);
}

const REPS_PATTERN = /^\d{1,3}(\s*[-–]\s*\d{1,3})?$/;
const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * The model's plan, checked against the library: names are matched without
 * regard to case and replaced by the library's own spelling and muscle group,
 * anything not in the library is dropped, numbers are clamped, and a day left
 * empty is dropped. What comes back is the shape the plan builder edits.
 * Throws when nothing usable is left.
 */
export function parsePlanReply(raw, library, { days: wantedDays } = {}) {
  let data;
  const cleaned = stripCodeFences(raw);
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        data = JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    if (!data) throw new Error('Plan reply was not JSON');
  }
  const byName = new Map(library.map((item) => [item.name.trim().toLowerCase(), item]));
  const dropped = [];
  const days = (Array.isArray(data?.days) ? data.days : [])
    .slice(0, wantedDays || 7)
    .map((day, index) => {
      const seen = new Set();
      const exercises = (Array.isArray(day?.exercises) ? day.exercises : [])
        .map((exercise) => {
          const wanted = String(exercise?.exercise_name ?? '').trim();
          const item = byName.get(wanted.toLowerCase());
          if (!item) {
            if (wanted) dropped.push(wanted);
            return null;
          }
          // The same move twice in a day is a slip, not a plan.
          if (seen.has(item.name)) return null;
          seen.add(item.name);
          const reps = String(exercise?.target_reps ?? '').trim();
          const rpe = Number(exercise?.target_rpe);
          return {
            exercise_name: item.name,
            muscle_group: item.muscle_group,
            target_sets: clampInt(exercise?.target_sets, 1, 8, 3),
            target_reps: REPS_PATTERN.test(reps) ? reps.replace(/\s+/g, '').replace('–', '-') : '8-12',
            target_rpe: Number.isFinite(rpe) && rpe >= 5 && rpe <= 10 ? Math.round(rpe * 2) / 2 : null,
            rest_seconds: clampInt(exercise?.rest_seconds, 0, 300, 90),
            notes: exercise?.notes ? String(exercise.notes).trim().slice(0, 300) || null : null,
            // The demo, so the builder shows the same pictures the picker does.
            media_url: item.media_url ?? null,
            media_type: item.media_type ?? null,
            instructions: item.instructions ?? null,
            secondary_muscles: item.secondary_muscles ?? [],
            equipment: item.equipment ?? null,
          };
        })
        .filter(Boolean)
        .slice(0, MAX_PLAN_EXERCISES_PER_DAY);
      return {
        day_name: String(day?.day_name ?? '').trim().slice(0, 60) || `Day ${index + 1}`,
        notes: day?.notes ? String(day.notes).trim().slice(0, 500) || null : null,
        exercises,
      };
    })
    .filter((day) => day.exercises.length);

  if (!days.length) throw new Error('Plan reply had no exercises from the library');
  return {
    plan: {
      name: String(data?.name ?? '').trim().slice(0, 60) || 'AI plan',
      description: data?.description ? String(data.description).trim().slice(0, 1000) : null,
      days,
    },
    dropped,
  };
}

/**
 * Asks Gemini for a plan. `request` is the member's choices (already checked
 * by the route), `context` the same member context the chat uses, `library`
 * the exercises they may use. Resolves to { plan, dropped, input_tokens,
 * output_tokens }; throws like askCoach.
 */
export async function generatePlan({ request, context, library }) {
  const ai = await getClient();
  const lines = library.map((item) => `${item.name} | ${item.muscle_group} | ${item.equipment ?? 'other'}`).join('\n');
  // A plan is about who they are and how they train, not today's food or a
  // session in progress.
  const { live_session: _live, exercise_history: _history, diet_today: _diet, screen: _screen, ...profile } = context;
  const response = await ai.models.generateContent({
    model: config.aiCoach.model,
    contents: [
      {
        role: 'user',
        parts: [{ text: `REQUEST:\n${JSON.stringify(request)}\n\nCONTEXT:\n${JSON.stringify(profile)}\n\nEXERCISE LIBRARY:\n${lines}` }],
      },
    ],
    config: {
      systemInstruction: PLAN_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: PLAN_SCHEMA,
      temperature: 0.6,
      // A week of days is a long JSON document, and on thinking models the
      // thinking counts against this too.
      maxOutputTokens: 16384,
      abortSignal: AbortSignal.timeout(Math.max(config.aiCoach.timeoutMs, 60000)),
    },
  });
  const parsed = parsePlanReply(response?.text, library, { days: request.days_per_week });
  return { ...parsed, ...usageOf(response?.usageMetadata) };
}

/* ── Plan review ──────────────────────────────────────────────────────── */

/** The coach inside the plan builder: rates the plan being edited, says what
 * is missing and suggests exercises from the gym's library, each one a button
 * that puts it in the plan. Members and staff (writing a gym template) both
 * use it, so the plan is reviewed as sent — the draft, not anything saved. */
export const PLAN_REVIEW_MODES = ['ask', 'rate'];
const MAX_REVIEW_DAYS = 7;
const MAX_REVIEW_DAY_EXERCISES = 30;
const MAX_REVIEW_SUGGESTIONS = 8;
const REVIEW_HISTORY_TURNS = 4;

/** Reviews in the last 24 hours, by a member or by a staff user. */
export function planReviewsToday({ memberId = null, userId = null }) {
  const [column, id] = memberId != null ? ['member_id', memberId] : ['user_id', userId];
  return get(
    `SELECT COUNT(*) AS n FROM ai_plan_reviews WHERE ${column} = ? AND created_at >= datetime('now', '-1 day')`,
    [id],
  ).n;
}

/**
 * The plan as the editor sent it, cut to what the coach needs. It came from
 * the client and may be half-written (an unnamed day, an empty one), so it is
 * coerced rather than validated; muscle groups come from the library where
 * the exercise is in it, so a tampered group cannot skew the volume count.
 */
export function sanitisePlanForReview(plan, library = []) {
  if (!plan || typeof plan !== 'object') return null;
  const byName = new Map(library.map((item) => [nameKey(item.name), item]));
  const days = (Array.isArray(plan.days) ? plan.days : []).slice(0, MAX_REVIEW_DAYS).map((day, index) => ({
    day: index + 1,
    day_name: text(day?.day_name, 60) || `Day ${index + 1}`,
    exercises: (Array.isArray(day?.exercises) ? day.exercises : [])
      .slice(0, MAX_REVIEW_DAY_EXERCISES)
      .map((exercise) => {
        const name = text(exercise?.exercise_name, 120);
        const known = byName.get(nameKey(name));
        const sent = text(exercise?.muscle_group, 30);
        return {
          exercise_name: name,
          muscle_group: known?.muscle_group ?? (MUSCLE_GROUPS.includes(sent) ? sent : 'other'),
          equipment: known?.equipment ?? undefined,
          sets: clampInt(exercise?.target_sets, 1, 20, 3),
          reps: text(exercise?.target_reps, 30) || '8-12',
          rest_seconds: clampInt(exercise?.rest_seconds, 0, 900, 90),
        };
      })
      .filter((exercise) => exercise.exercise_name),
  }));
  return {
    name: text(plan.name, 100) || null,
    goal: text(plan.goal, 30) || null,
    level: text(plan.level, 30) || null,
    days_per_week: plan.days_per_week == null || plan.days_per_week === '' ? null : clampInt(plan.days_per_week, 1, 7, null),
    days,
  };
}

/**
 * Direct working sets per muscle group in a week: each day's sets on its
 * primary muscle, scaled when the plan runs more or fewer times a week than
 * it has days. Worked out here rather than by the model, which miscounts, and
 * shown beside the rating so its numbers can be checked.
 */
export function weeklySets(plan) {
  const counted = plan?.days?.filter((day) => day.exercises.length) ?? [];
  if (!counted.length) return [];
  const scale = plan.days_per_week ? plan.days_per_week / counted.length : 1;
  const totals = new Map();
  for (const day of counted) {
    for (const exercise of day.exercises) {
      if (exercise.muscle_group === 'cardio' || exercise.muscle_group === 'other') continue;
      totals.set(exercise.muscle_group, (totals.get(exercise.muscle_group) ?? 0) + exercise.sets);
    }
  }
  return [...totals]
    .map(([muscle_group, sets]) => ({ muscle_group, sets: Math.round(sets * scale * 2) / 2 }))
    .sort((a, b) => b.sets - a.sets);
}

const REVIEW_INSTRUCTION = `You are an expert strength coach inside a gym's workout plan builder. The person editing the plan (a member building their own, or a trainer writing one for the gym) asks you about it: rate it, find what is missing, or suggest the best exercises for a muscle.

You get the PLAN being edited (its days and exercises with sets, reps and rest), WEEKLY SETS (direct working sets per muscle group per week, already counted for you — use these numbers, do not recount), the MEMBER profile when there is one (sex, age, goal, injuries or limitations, recent training), and the gym's EXERCISE LIBRARY, one per line as "name | muscle group | equipment".

Judging a plan for muscle building (hypertrophy), the evidence-based standard:
- About 10-20 hard sets per muscle per week for most people (beginners do well from ~8-10); under ~8 is low, over ~25 is junk volume that hurts recovery.
- Each muscle trained about twice a week beats once.
- Mostly 6-15 reps (5-8 on heavy compounds, 10-20 on isolation and small muscles), close to failure (RPE 7-9).
- Rest 2-3 min on heavy compounds, 60-120 s on isolation; under 60 s on big lifts costs growth.
- Compound lifts first, then isolation. About 4-8 exercises and 12-25 sets per session; much more is too long to train hard.
- Balanced: horizontal and vertical pushes matched by pulls, quads matched by hamstrings and glutes, rear delts and calves not forgotten, some core work.
- No two days in a row that hit the same muscle hard.
- Count indirect work sensibly: pressing also trains triceps and front delts, rows and pulldowns train biceps and rear delts, squats and lunges train glutes. Do not call a muscle neglected just because it has few direct sets when the big lifts cover it.
For other goals judge against that goal instead (strength: heavy low reps and long rests; fat loss and endurance: higher reps, shorter rest, some conditioning).

How to answer:
- "answer": 2-5 short sentences. Lead with the verdict or the answer, then the reason that matters most. Use their actual exercise names and numbers. Wrap key numbers and exercise names in **double asterisks**; no other markdown, no lists.
- When TASK is "rate" (or the question asks you to rate, review or judge the plan), fill "rating": a score from 1 to 10 for the goal (be honest: 9-10 only for a plan with no real gaps, 5-6 for one that works but has clear problems, 3 or less for one that is mostly missing), a 2-5 word verdict, "strengths" with 1-3 things it does well, and "improvements" with 2-4 concrete fixes, most important first, each one short sentence naming the day and the change. Leave "rating" out otherwise.
- "suggestions": exercises to add or swap in, ONLY copied character for character from the EXERCISE LIBRARY, never invented or renamed. Fill them whenever you recommend an exercise: always for "best exercises for X" (3-5 picks, varied equipment and angles, the best first), and for the fixes behind a rating (at most 8). "day" is the number of the plan day it belongs on (the day that already trains that area or has room). When no existing day suits it (say, leg exercises in a plan with no leg day) and the plan has fewer than 7 days, leave "day" out and set "new_day" to a short name for a day to add ("Legs"), the same name for every exercise meant for that day. "replaces" is the exact name of an exercise on that day it should replace, only for a swap. Give target sets, reps and rest suited to the goal, and a one-line "reason". Do not suggest an exercise already on that day.
- Respect any injuries or limitations absolutely: never suggest something that loads an injured area.
- Stay on training. Politely decline anything else.
- Answer in the language the person writes in. Many write Hinglish — Hindi in Roman letters mixed with English; answer them the same way, keeping exercise names, units and numbers in English.`;

// No minItems/maxItems on the lists: Vertex rejects nested ones with a 400.
// parseReviewReply enforces the counts.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    // Strengths and fixes inside the rating, so they are required with it:
    // left beside it, the model often gave a score and skipped the fixes.
    rating: {
      type: 'object',
      description: 'Only when asked to rate or review the plan.',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 10 },
        verdict: { type: 'string', description: '2-5 words, e.g. "Solid, needs more back".' },
        strengths: { type: 'array', items: { type: 'string' }, description: 'Up to 3 things the plan does well.' },
        improvements: { type: 'array', items: { type: 'string' }, description: 'Up to 4 concrete fixes, most important first.' },
      },
      required: ['score', 'verdict', 'strengths', 'improvements'],
    },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          exercise_name: { type: 'string', description: 'Exactly as written in the EXERCISE LIBRARY.' },
          day: { type: 'integer', description: 'The plan day number it goes on.' },
          new_day: { type: 'string', description: 'Instead of day: the name of a new day to add, when no existing day suits it.' },
          replaces: { type: 'string', description: 'Only for a swap: the exact name of the exercise on that day it replaces.' },
          target_sets: { type: 'integer', minimum: 1, maximum: 8 },
          target_reps: { type: 'string' },
          rest_seconds: { type: 'integer', minimum: 0, maximum: 300 },
          reason: { type: 'string' },
        },
        required: ['exercise_name', 'target_sets', 'target_reps', 'rest_seconds', 'reason'],
      },
    },
  },
  required: ['answer'],
};

const points = (list, max, count) =>
  (Array.isArray(list) ? list : [])
    .map((item) => text(item, max))
    .filter(Boolean)
    .slice(0, count);

/**
 * The model's review, checked: an answer is required; a rating is kept only
 * with a usable score; every suggestion must name a library exercise (given
 * back in the library's spelling, with its muscle group and demo), its day
 * must exist in the plan and a swap must name an exercise on that day. What
 * fails is dropped — the answer still says it, there is just no button.
 */
export function parseReviewReply(raw, { library, plan }) {
  let data;
  const cleaned = stripCodeFences(raw);
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        data = JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    if (!data) throw new Error('Review reply was not JSON');
  }
  const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
  if (!answer) throw new Error('Review reply had no answer');

  const score = Math.round(Number(data.rating?.score));
  const rating =
    Number.isFinite(score) && score >= 1 && score <= 10 ? { score, verdict: text(data.rating.verdict, 60) || null } : null;
  // Inside the rating as asked for, or beside it as an older reply had them.
  const strengths = data.rating?.strengths ?? data.strengths;
  const improvements = data.rating?.improvements ?? data.improvements;

  const byName = new Map(library.map((item) => [nameKey(item.name), item]));
  const days = plan?.days ?? [];
  const dropped = [];
  const seen = new Set();
  const suggestions = [];
  for (const wanted of Array.isArray(data.suggestions) ? data.suggestions : []) {
    if (suggestions.length >= MAX_REVIEW_SUGGESTIONS) break;
    const name = text(wanted?.exercise_name, 120);
    const item = byName.get(nameKey(name));
    if (!item) {
      if (name) dropped.push(name);
      continue;
    }
    const dayNumber = Number(wanted?.day);
    const day = Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= days.length ? days[dayNumber - 1] : null;
    const replaced = day?.exercises.find(
      (exercise) => nameKey(exercise.exercise_name) === nameKey(wanted?.replaces) && nameKey(exercise.exercise_name) !== nameKey(item.name),
    );
    // Already on that day and not a swap for something else: nothing to do.
    if (day && !replaced && day.exercises.some((exercise) => nameKey(exercise.exercise_name) === nameKey(item.name))) continue;
    const key = `${item.name}|${day?.day ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reps = String(wanted?.target_reps ?? '').trim();
    suggestions.push({
      exercise_name: item.name,
      muscle_group: item.muscle_group,
      equipment: item.equipment ?? null,
      day_index: day ? day.day - 1 : null,
      // A day to add for it, when none suits it and there is room for one more.
      new_day: !day && days.length < MAX_REVIEW_DAYS ? text(wanted?.new_day, 60) || null : null,
      replaces: replaced?.exercise_name ?? null,
      target_sets: clampInt(wanted?.target_sets, 1, 8, 3),
      target_reps: REPS_PATTERN.test(reps) ? reps.replace(/\s+/g, '').replace('–', '-') : '8-12',
      rest_seconds: clampInt(wanted?.rest_seconds, 0, 300, 90),
      reason: text(wanted?.reason, 200) || null,
      // The demo, so the card and the builder row show the same picture.
      media_url: item.media_url ?? null,
      media_type: item.media_type ?? null,
      instructions: item.instructions ?? null,
      secondary_muscles: item.secondary_muscles ?? [],
    });
  }

  return {
    answer: answer.slice(0, 2000),
    rating,
    strengths: rating ? points(strengths, 200, 3) : [],
    improvements: rating ? points(improvements, 240, 4) : [],
    suggestions,
    dropped,
  };
}

/** Earlier turns from the same sheet, as the client sent them back. */
export function sanitiseReviewHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-REVIEW_HISTORY_TURNS)
    .map((turn) => ({ question: text(turn?.question, MAX_QUESTION_LENGTH), answer: text(turn?.answer, 2000) }))
    .filter((turn) => turn.question && turn.answer);
}

/**
 * What the coach reads before it answers about a plan, as the "reading" lines
 * of the streamed reply — the same pattern as contextSteps, from what it is
 * actually sent.
 */
export function reviewSteps({ plan, member, library }) {
  const days = plan.days.filter((day) => day.exercises.length);
  const exercises = days.reduce((n, day) => n + day.exercises.length, 0);
  const steps = [
    exercises
      ? `Reading your plan — ${plural(days.length, 'day')}, ${plural(exercises, 'exercise')}`
      : 'Reading your plan — no exercises in it yet',
  ];
  const sets = weeklySets(plan);
  if (sets.length) {
    const top = sets
      .slice(0, 3)
      .map((row) => `${row.muscle_group.replace(/_/g, ' ')} ${row.sets}`)
      .join(', ');
    steps.push(`Counting sets per muscle — ${top}${sets.length > 3 ? '…' : ''}`);
    steps.push('Checking balance and recovery between days');
  }
  if (member) steps.push('Reading your profile and goal');
  if (member?.limitations) steps.push('Keeping your injury notes in mind');
  steps.push(`Choosing from your gym's ${plural(library.length, 'exercise')}`);
  return steps;
}

/** The generateContent params for one question about a plan, shared by the
 * plain and the streamed review. */
function reviewParams({ plan, mode, question, history, member, library, signal }) {
  const sets = weeklySets(plan);
  const lines = library.map((item) => `${item.name} | ${item.muscle_group} | ${item.equipment ?? 'other'}`).join('\n');
  const contents = [];
  for (const turn of sanitiseReviewHistory(history)) {
    contents.push({ role: 'user', parts: [{ text: turn.question }] });
    contents.push({ role: 'model', parts: [{ text: JSON.stringify({ answer: turn.answer }) }] });
  }
  // The plan rides on the newest question, so a follow-up sees the edits made since.
  contents.push({
    role: 'user',
    parts: [
      {
        text: [
          `TASK: ${mode}`,
          `PLAN:\n${JSON.stringify(plan)}`,
          `WEEKLY SETS:\n${JSON.stringify(sets)}`,
          member ? `MEMBER:\n${JSON.stringify(member)}` : 'MEMBER: none — a gym template for any member at its level',
          `EXERCISE LIBRARY:\n${lines}`,
          `QUESTION:\n${question}`,
        ].join('\n\n'),
      },
    ],
  });
  const timeout = AbortSignal.timeout(Math.max(config.aiCoach.timeoutMs, 60000));
  return {
    model: config.aiCoach.model,
    contents,
    config: {
      systemInstruction: REVIEW_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: REVIEW_SCHEMA,
      temperature: 0.4,
      // Thinking counts against this on thinking models; a rating with its
      // fixes and suggestions is a few hundred tokens of JSON after it. At a
      // 2048 thinking budget a rating took ~26 s.
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 1024 },
      abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    },
  };
}

/**
 * One question about the plan being edited. `plan` is the sanitised plan,
 * `member` the member's profile (null for a staff template), `library` the
 * exercises it may suggest. Resolves to the parsed review plus weekly_sets and
 * token counts; throws like askCoach.
 */
export async function reviewPlan({ plan, mode = 'ask', question, history = [], member = null, library, signal }) {
  const ai = await getClient();
  const response = await ai.models.generateContent(reviewParams({ plan, mode, question, history, member, library, signal }));
  const parsed = parseReviewReply(response?.text, { library, plan });
  return { ...parsed, weekly_sets: weeklySets(plan), ...usageOf(response?.usageMetadata) };
}

/**
 * The same review, streamed like streamCoach: thought summaries to onThought,
 * the "answer" string to onAnswer as it is written. Resolves and throws
 * exactly like reviewPlan.
 */
export async function streamReviewPlan({ plan, mode = 'ask', question, history = [], member = null, library, signal, onThought, onAnswer }) {
  const ai = await getClient();
  const params = reviewParams({ plan, mode, question, history, member, library, signal });
  params.config.thinkingConfig = { ...params.config.thinkingConfig, includeThoughts: true };
  const stream = await ai.models.generateContentStream(params);

  let raw = '';
  let sent = 0;
  let usage;
  for await (const chunk of stream) {
    if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) {
        onThought?.(part.text);
        continue;
      }
      raw += part.text;
      const soFar = partialAnswer(raw);
      if (soFar.length > sent) {
        onAnswer?.(soFar.slice(sent));
        sent = soFar.length;
      }
    }
  }
  const parsed = parseReviewReply(raw, { library, plan });
  return { ...parsed, weekly_sets: weeklySets(plan), ...usageOf(usage) };
}
