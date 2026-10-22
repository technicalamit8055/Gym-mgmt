/**
 * The Android app's home-screen widgets: the diet tracker (calories left,
 * macros, water with a +250 ml button, + Food) and Hevy's workout widget (this
 * week's workouts, the weekly streak, and the next workout with Start).
 *
 * The widgets draw a snapshot this module hands to the app's own Widgets
 * plugin (android/…/GymWidgets.java) whenever the numbers may have changed:
 * when the portal opens, when the app comes back to the foreground, and after
 * anything fitness-related is saved (api.js raises gymbook:fitness-changed).
 * A workout in progress reaches the workout widget through the workout
 * notification instead (liveWorkout.js). On the web — and in an app build
 * without the plugin — every export is a no-op.
 */
import { api, isNativeApp, memberSession, pathPrefix, serverUrl } from './api.js';
import { today } from './ui.js';

const PLUGIN = 'Widgets';
const available = isNativeApp && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
const call = (method, options = {}) => window.Capacitor.nativePromise(PLUGIN, method, options);

/* ------------------------------------------------------------ the taps */

let handler = null;
const queued = [];

function dispatch(event) {
  if (handler) handler(event);
  else queued.push(event);
}

/**
 * Who handles `{ type: 'open', target }` (a widget opened the app at diet |
 * food | workout | start_workout) and `{ type: 'changed' }` (the widget's
 * water button logged a glass). The portal sets this when it mounts; a tap
 * that launched the app is handed over then.
 */
export function setWidgetHandler(fn) {
  handler = fn;
  while (handler && queued.length) handler(queued.shift());
}

/* ------------------------------------------------------------ the sync */

let timer = null;

/** The snapshot GymWidgets.java documents, or null when there is nothing to
 * show. Any request failing (offline, say) throws, so the widgets keep the
 * last good figures instead of blanking. */
async function snapshot() {
  if (!memberSession.token) return null;
  const date = today();
  const status = await api.portal.fitnessStatus();
  if (!status.has_access) return { date, access: false };

  const [plan, day, logs, current] = await Promise.all([
    api.portal.currentDiet(),
    api.portal.dietDay(date),
    api.portal.workoutLogs({ limit: 200 }),
    api.portal.currentWorkout(),
  ]);
  const { targets } = plan;
  return {
    date,
    access: true,
    diet: {
      goal: day.budget.goal,
      exercise: day.budget.exercise,
      eaten: day.totals.calories,
      protein: day.totals.protein_g,
      protein_target: targets.target_protein_g,
      carbs: day.totals.carbs_g,
      carbs_target: targets.target_carbs_g,
      fats: day.totals.fats_g,
      fats_target: targets.target_fats_g,
      water_ml: day.water_ml,
      water_target_ml: targets.target_water_ml,
    },
    workout: {
      dates: [...new Set(logs.items.map((log) => log.log_date))],
      next: current?.today_day
        ? { name: current.today_day.day_name, plan: current.plan?.name ?? '', exercises: current.today_day.exercises.length }
        : null,
    },
    // The water button posts here itself, so a glass needs no app open.
    water: { url: serverUrl(`${pathPrefix}/api/portal/diets/water`), token: memberSession.token },
  };
}

async function send() {
  timer = null;
  const content = await snapshot();
  await (content ? call('update', content) : call('clear'));
}

/** Brings the widgets up to date. Batched: logging a meal's foods one by one
 * should cost one round of requests, not one per food. */
export function refreshWidgets() {
  if (!available) return;
  clearTimeout(timer);
  timer = setTimeout(() => send().catch(() => {}), 1500);
}

/** Signed out: the widgets ask to sign in, and forget the token. */
export function clearWidgets() {
  if (!available) return;
  clearTimeout(timer);
  timer = null;
  call('clear').catch(() => {});
}

if (available) {
  window.Capacitor.addListener(PLUGIN, 'open', (event) => dispatch({ type: 'open', target: event?.target }));
  window.Capacitor.addListener(PLUGIN, 'changed', () => dispatch({ type: 'changed' }));
  window.addEventListener('gymbook:fitness-changed', refreshWidgets);
  window.addEventListener('gymbook:member-signed-out', clearWidgets);
  // Back from the home screen: a new day, or something logged on another device.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshWidgets();
  });
}
