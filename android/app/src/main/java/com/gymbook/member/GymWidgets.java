package com.gymbook.member;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the home-screen widgets (DietWidget, WorkoutWidget) show, and where
 * their taps lead.
 *
 * The web app hands over a snapshot (public/js/widgets.js, through
 * WidgetsPlugin) whenever its numbers may have changed; the widgets only draw
 * it, so they cost nothing between updates. A workout in progress is not in
 * it: WorkoutWidget reads the workout notification's own payload for that.
 *
 * Snapshot:
 *   date      the day ("2026-10-22") its diet figures are for — read on a
 *             later day, they count as nothing eaten yet
 *   access    false when the member has no workout & diet add-on
 *   diet      { goal, exercise, eaten, protein, protein_target, carbs,
 *             carbs_target, fats, fats_target, water_ml, water_target_ml }
 *   workout   { dates: ["2026-10-20", …] with a workout logged,
 *             next: { name, plan, exercises } or null }
 *   water     { url, token } — where DietWidget's +250 ml button posts
 * No snapshot at all: nobody is signed in.
 */
final class GymWidgets {

    static final String EXTRA_OPEN = "com.gymbook.member.WIDGET_OPEN";
    static final String OPEN_DIET = "diet";
    static final String OPEN_FOOD = "food";
    static final String OPEN_WORKOUT = "workout";
    static final String OPEN_START = "start_workout";

    private static final String PREFS = "widgets";
    private static final String KEY_SNAPSHOT = "snapshot";

    /** The figures of one day, which a new day starts again from zero. */
    private static final String[] DAY_FIELDS = { "eaten", "exercise", "protein", "carbs", "fats", "water_ml" };

    private GymWidgets() {}

    static synchronized JSONObject snapshot(Context context) {
        String raw = prefs(context).getString(KEY_SNAPSHOT, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    static synchronized void save(Context context, JSONObject snapshot) {
        prefs(context).edit().putString(KEY_SNAPSHOT, snapshot.toString()).apply();
        refreshAll(context);
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().remove(KEY_SNAPSHOT).apply();
        refreshAll(context);
    }

    static void refreshAll(Context context) {
        Context app = context.getApplicationContext();
        DietWidget.refresh(app);
        WorkoutWidget.refresh(app);
    }

    /** What a widget says instead of its figures, or null when it has them. */
    static String message(JSONObject snapshot) {
        if (snapshot == null) return "Sign in to GymVym to see your day here";
        if (!snapshot.optBoolean("access", true)) return "Unlock workout & diet tracking in GymVym";
        return null;
    }

    /** Today's diet: the snapshot's, or — when that was another day — its
     * targets with nothing logged against them yet. */
    static JSONObject dietToday(JSONObject snapshot) {
        JSONObject diet = snapshot == null ? null : snapshot.optJSONObject("diet");
        if (diet == null || today().equals(snapshot.optString("date"))) return diet;
        try {
            JSONObject fresh = new JSONObject(diet.toString());
            for (String field : DAY_FIELDS) fresh.put(field, 0);
            return fresh;
        } catch (JSONException e) {
            return null;
        }
    }

    /** Moves today's water by `deltaMl` — DietWidget's button, shown before
     * the server has answered. */
    static synchronized void bumpWater(Context context, int deltaMl) {
        JSONObject snapshot = snapshot(context);
        JSONObject diet = dietToday(snapshot);
        if (diet == null) return;
        try {
            diet.put("water_ml", Math.max(0, diet.optInt("water_ml") + deltaMl));
            snapshot.put("diet", diet).put("date", today());
        } catch (JSONException e) {
            return;
        }
        save(context, snapshot);
    }

    /** The server's own water total for `day`, once it has answered. */
    static synchronized void setWater(Context context, String day, int waterMl) {
        JSONObject snapshot = snapshot(context);
        JSONObject diet = snapshot == null ? null : snapshot.optJSONObject("diet");
        if (diet == null || waterMl < 0 || !day.equals(snapshot.optString("date"))) return;
        try {
            diet.put("water_ml", waterMl);
        } catch (JSONException e) {
            return;
        }
        save(context, snapshot);
    }

    /** Opens the app at `target` (one of OPEN_*), handed to the page by WidgetsPlugin. */
    static PendingIntent openIntent(Context context, String target) {
        // A distinct action per target, or Android would treat them as one PendingIntent.
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(EXTRA_OPEN + "." + target)
            .putExtra(EXTRA_OPEN, target)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, target.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static String today() {
        return iso(Calendar.getInstance());
    }

    /** The local date as the web app writes it (today() in ui.js). */
    static String iso(Calendar day) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(day.getTimeInMillis()));
    }

    static String number(long value) {
        return NumberFormat.getIntegerInstance(Locale.US).format(value);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
