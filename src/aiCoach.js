import { config } from './config.js';
import { all, get } from './db.js';
import { exerciseHistory } from './fitness.js';
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

You are given MEMBER CONTEXT as JSON: their profile, injuries or limitations, current plan, the live workout session (every set so far with weight, reps and effort as RPE), recent history for those exercises, the last week of workouts, and today's food against their targets. Weights in the context are kilograms; "unit" is what the member uses, so give every weight in that unit, rounded to what a gym actually has. The smallest plate is 2.5 kg, so a barbell or Smith machine only goes up or down in 5 kg steps (a 2.5 kg plate on each side); dumbbells go in 2.5 kg steps; pounds go in 5 lb steps. Never suggest 1.25 kg plates or any load that needs them, such as 32.5 kg on a bar. When the next 5 kg step is too big a jump, say add reps at the same weight first.

How to answer:
- 2 to 5 short sentences. Lead with the answer (a number, a choice), then the one reason that matters. No headings, no lists unless they ask for a plan.
- Wrap the numbers the member acts on in **double asterisks** (e.g. "**2413 calories, 82g protein** left"); no other markdown. A blank line may split the answer into two short paragraphs.
- Use their actual numbers. Prefer the context to generic advice; say so when there is no history to go on.
- For "what weight/reps next", work from the set they just did: below the target rep range or a failed set means go lighter; past the top of the range or an easy set means go heavier; otherwise hold. "next_set_suggestion" in the session is the app's own rule-based pick — agree with it or explain why you differ.
- When you recommend a specific next set for one exercise in the session, also fill "suggestion" with that exercise's exact name, the weight in kilograms and the reps. Leave it out for anything else.
- Be conservative around anything listed under limitations and around pain: suggest a lighter or alternative movement and seeing a trainer or doctor. Never diagnose or treat medical conditions, and never recommend drugs, supplements beyond basics like protein or creatine, or extreme diets.
- Stay on fitness, exercise, recovery and nutrition. Politely decline anything else.
- Answer in the language the member writes in.`;

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
      equipment: text(exercise?.equipment, 30) || undefined,
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
    })),
  };
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
export function buildCoachContext(memberId, { screen, session, unit, planId }) {
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

  const { targets } = effectiveDietTargets(memberId);
  const food = get(
    `SELECT COALESCE(SUM(e.calories), 0) AS calories, COALESCE(SUM(e.protein_g), 0) AS protein_g,
            COALESCE(SUM(e.carbs_g), 0) AS carbs_g, COALESCE(SUM(e.fats_g), 0) AS fats_g, COUNT(e.id) AS items
     FROM diet_logs d LEFT JOIN diet_log_entries e ON e.diet_log_id = d.id
     WHERE d.member_id = ? AND d.log_date = ?`,
    [memberId, on],
  ) ?? { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0, items: 0 };
  const burned = exerciseForDay(memberId, on).total_burned;

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
    `SELECT question, answer FROM ai_coach_messages
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
    contents.push({ role: 'model', parts: [{ text: JSON.stringify({ answer: turn.answer }) }] });
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
      maxOutputTokens: 1024,
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
  params.config.thinkingConfig = { includeThoughts: true };
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

/** The model's JSON, checked: an answer is required, a suggestion is kept
 * only when every field is a usable number. */
export function parseReply(raw) {
  let data;
  try {
    data = JSON.parse(String(raw ?? '').trim());
  } catch {
    throw new Error('Coach reply was not JSON');
  }
  const answer = typeof data?.answer === 'string' ? data.answer.trim() : '';
  if (!answer) throw new Error('Coach reply had no answer');
  const s = data.suggestion;
  const suggestion =
    s && typeof s.exercise === 'string' && Number.isFinite(Number(s.weight_kg)) && Number(s.reps) >= 1
      ? { exercise: s.exercise.trim().slice(0, 120), weight_kg: round1(Math.max(0, Number(s.weight_kg))), reps: Math.round(Number(s.reps)) }
      : null;
  return { answer: answer.slice(0, 2000), suggestion };
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
  try {
    data = JSON.parse(String(raw ?? '').trim());
  } catch {
    throw new Error('Plan reply was not JSON');
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
